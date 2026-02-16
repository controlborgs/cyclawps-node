import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { StateEngine } from '../modules/state-engine/state-engine.service.js';
import type { PatternDatabase } from '../intelligence/pattern-db.js';
import type { LLMClient } from './llm.js';
import { Agent } from './base-agent.js';
import type { AgentConfig, AgentMessage, ExecutionPlan, TokenAnalysis } from './types.js';
import { randomUUID } from 'node:crypto';

export interface StrategistDeps {
  llm: LLMClient;
  stateEngine: StateEngine;
  patternDb: PatternDatabase;
}

const SYSTEM_PROMPT = `You are a portfolio strategist for an autonomous Solana trading agent. You receive token analyses from the Analyst and must decide whether to enter a position, considering the full portfolio context.

Output a JSON object with:
- action: "enter" | "skip"
- solAmount: number (how much SOL to allocate, 0 if skipping)
- maxSlippageBps: number (max slippage in basis points)
- reasoning: string (1-2 sentences)

Rules:
- Never allocate more than 20% of available balance to a single position
- If portfolio has 5+ open positions, require conviction > 70 to enter
- If on a losing streak (3+ consecutive losses), reduce position sizes by 50%
- If risk profile is "extreme", always skip
- If conviction < 30, always skip
- Prefer smaller positions when uncertainty is high`;

export class StrategistAgent extends Agent {
  private readonly deps: StrategistDeps;
  private readonly analysisQueue: TokenAnalysis[] = [];
  private recentOutcomes: boolean[] = []; // true = win, false = loss

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: StrategistDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Receive analyses from Analyst
    this.onMessage('token-analysis', (msg: AgentMessage) => {
      const analysis = msg.payload as TokenAnalysis;
      this.analysisQueue.push(analysis);

      this.container.logger.info(
        { mint: analysis.mintAddress, conviction: analysis.convictionScore },
        'Strategist received analysis',
      );
    });

    // Track outcomes from Memory
    this.onMessage('outcome', (msg: AgentMessage) => {
      const outcome = msg.payload as { pnlPercent: number };
      this.recentOutcomes.push(outcome.pnlPercent > 0);
      // Keep last 20
      if (this.recentOutcomes.length > 20) {
        this.recentOutcomes.shift();
      }
    });
  }

  protected async onStop(): Promise<void> {
    this.analysisQueue.length = 0;
  }

  protected async tick(): Promise<void> {
    if (this.analysisQueue.length === 0) return;

    const analysis = this.analysisQueue.shift();
    if (analysis) {
      await this.evaluate(analysis);
    }
  }

  private async evaluate(analysis: TokenAnalysis): Promise<void> {
    // Quick filters
    if (analysis.riskProfile === 'extreme') {
      this.container.logger.info(
        { mint: analysis.mintAddress },
        'Strategist skipping extreme risk',
      );
      return;
    }

    if (analysis.convictionScore < 30) {
      this.container.logger.info(
        { mint: analysis.mintAddress, conviction: analysis.convictionScore },
        'Strategist skipping low conviction',
      );
      return;
    }

    // Portfolio context
    const openPositions = this.deps.stateEngine.getOpenPositions();
    const positionCount = openPositions.length;

    // Check if we already have a position in this token
    const existingPosition = openPositions.find((p) => p.mintAddress === analysis.mintAddress);
    if (existingPosition) {
      this.container.logger.info(
        { mint: analysis.mintAddress },
        'Strategist skipping — already have position',
      );
      return;
    }

    // Losing streak detection
    const recentLosses = this.recentOutcomes.slice(-3);
    const onLosingStreak = recentLosses.length >= 3 && recentLosses.every((o) => !o);

    // Win rate
    const totalTrades = this.recentOutcomes.length;
    const winRate = totalTrades > 0
      ? this.recentOutcomes.filter((o) => o).length / totalTrades
      : 0.5;

    // LLM decision
    try {
      const decision = await this.deps.llm.reasonJSON<{
        action: 'enter' | 'skip';
        solAmount: number;
        maxSlippageBps: number;
        reasoning: string;
      }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `## Token Analysis
- Mint: ${analysis.mintAddress}
- Deployer score: ${analysis.deployerScore}/100
- Conviction: ${analysis.convictionScore}/100
- Risk profile: ${analysis.riskProfile}
- Analyst reasoning: ${analysis.reasoning}
- Recommended size: ${analysis.recommendedPositionSizeSol} SOL

## Portfolio State
- Open positions: ${positionCount}
- Recent win rate: ${(winRate * 100).toFixed(0)}% (${totalTrades} trades)
- On losing streak: ${onLosingStreak}
- Max position size: ${this.container.riskParams.maxPositionSizeSol} SOL

Should we enter this position?`,
      });

      if (decision.action === 'skip') {
        this.container.logger.info(
          { mint: analysis.mintAddress, reasoning: decision.reasoning },
          'Strategist decided to skip',
        );
        return;
      }

      // Cap position size
      let solAmount = Math.min(decision.solAmount, this.container.riskParams.maxPositionSizeSol);
      if (onLosingStreak) {
        solAmount *= 0.5;
      }

      const plan: ExecutionPlan = {
        id: randomUUID(),
        action: 'enter',
        mintAddress: analysis.mintAddress,
        solAmount,
        maxSlippageBps: decision.maxSlippageBps || this.container.riskParams.maxSlippageBps,
        priorityFeeLamports: this.container.riskParams.maxPriorityFeeLamports,
        urgency: 'medium',
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      };

      this.sendMessage('executor', 'execution-plan', plan);

      this.container.logger.info(
        {
          mint: analysis.mintAddress,
          solAmount,
          reasoning: decision.reasoning,
        },
        'Strategist sent execution plan',
      );
    } catch (err) {
      this.container.logger.error(
        { err, mint: analysis.mintAddress },
        'Strategist LLM decision failed',
      );
    }
  }
}

import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { PatternDatabase } from '../intelligence/pattern-db.js';
import type { DeployerScoreEngine } from '../intelligence/deployer-scores.js';
import type { StateEngine } from '../modules/state-engine/state-engine.service.js';
import { Agent } from './base-agent.js';
import type { AgentConfig, AgentMessage, DecisionOutcome } from './types.js';

export interface MemoryDeps {
  patternDb: PatternDatabase;
  deployerScores: DeployerScoreEngine;
  stateEngine: StateEngine;
}

interface ExecutionResult {
  planId: string;
  mintAddress: string;
  positionId?: string;
  action: string;
  success: boolean;
  signature?: string;
  solAmount?: number;
  tokensReceived?: string;
  sellPercentage?: number;
  error?: string;
  timestamp: number;
}

const OUTCOMES_KEY = 'cyclawps:memory:outcomes';
const STATS_KEY = 'cyclawps:memory:stats';

export class MemoryAgent extends Agent {
  private readonly deps: MemoryDeps;
  private readonly pendingResults: ExecutionResult[] = [];
  private outcomes: DecisionOutcome[] = [];

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: MemoryDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Listen for execution results
    this.onMessage('execution-result', (msg: AgentMessage) => {
      const result = msg.payload as ExecutionResult;
      this.pendingResults.push(result);

      this.container.logger.info(
        {
          planId: result.planId,
          action: result.action,
          success: result.success,
          mint: result.mintAddress,
        },
        'Memory received execution result',
      );
    });

    // Load historical outcomes from Redis
    await this.loadOutcomes();

    this.container.logger.info(
      { historicalOutcomes: this.outcomes.length },
      'Memory agent initialized',
    );
  }

  protected async onStop(): Promise<void> {
    await this.persistOutcomes();
  }

  protected async tick(): Promise<void> {
    // Process pending results
    while (this.pendingResults.length > 0) {
      const result = this.pendingResults.shift();
      if (result) {
        await this.processResult(result);
      }
    }

    // Periodically evaluate closed positions for P&L
    await this.evaluateClosedPositions();

    // Persist every 10 ticks
    if (this.getStatus().tickCount % 10 === 0) {
      await this.persistOutcomes();
      await this.updateStats();
    }
  }

  private async processResult(result: ExecutionResult): Promise<void> {
    const outcome: DecisionOutcome = {
      decisionId: result.planId,
      agentRole: 'executor',
      action: result.action,
      mintAddress: result.mintAddress,
      timestamp: result.timestamp,
      context: {
        success: result.success,
        signature: result.signature,
        error: result.error,
      },
    };

    if (result.action === 'enter' && result.success && result.solAmount) {
      outcome.entryPrice = result.solAmount;
    }

    this.outcomes.push(outcome);

    // If this was a failed entry from a deployer, note it
    if (result.action === 'enter' && !result.success) {
      this.container.logger.warn(
        { mint: result.mintAddress, error: result.error },
        'Memory: entry failed — recording for pattern analysis',
      );
    }
  }

  private async evaluateClosedPositions(): Promise<void> {
    // Find outcomes that were entries but don't have exit data yet
    for (const outcome of this.outcomes) {
      if (outcome.action !== 'enter' || outcome.exitPrice !== undefined) continue;

      // Check if position was closed
      const positions = this.deps.stateEngine.getPositionsByMint(outcome.mintAddress);
      const closed = positions.find(
        (p) => p.status === 'CLOSED' && p.mintAddress === outcome.mintAddress,
      );

      if (closed && outcome.entryPrice) {
        // Find corresponding exit
        const exitOutcome = this.outcomes.find(
          (o) =>
            o.mintAddress === outcome.mintAddress &&
            (o.action === 'exit' || o.action === 'partial_exit') &&
            o.timestamp > outcome.timestamp,
        );

        if (exitOutcome?.context?.['solReceived']) {
          const solReceived = exitOutcome.context['solReceived'] as number;
          outcome.exitPrice = solReceived;
          outcome.pnlSol = solReceived - outcome.entryPrice;
          outcome.pnlPercent = ((solReceived - outcome.entryPrice) / outcome.entryPrice) * 100;
          outcome.holdDurationMs = (exitOutcome.timestamp - outcome.timestamp);
          outcome.wasCorrect = outcome.pnlSol > 0;

          this.container.logger.info(
            {
              mint: outcome.mintAddress,
              pnlSol: outcome.pnlSol.toFixed(4),
              pnlPercent: outcome.pnlPercent.toFixed(1),
              holdMs: outcome.holdDurationMs,
            },
            'Memory: position outcome evaluated',
          );

          // Notify strategist of outcome
          this.sendMessage('strategist', 'outcome', {
            mintAddress: outcome.mintAddress,
            pnlPercent: outcome.pnlPercent,
            wasCorrect: outcome.wasCorrect,
          });
        }
      }
    }
  }

  // --- Persistence ---

  private async loadOutcomes(): Promise<void> {
    try {
      const data = await this.container.redis.get(OUTCOMES_KEY);
      if (data) {
        this.outcomes = JSON.parse(data) as DecisionOutcome[];
      }
    } catch (err) {
      this.container.logger.error({ err }, 'Memory: failed to load outcomes');
    }
  }

  private async persistOutcomes(): Promise<void> {
    try {
      // Keep last 500 outcomes
      const toSave = this.outcomes.slice(-500);
      await this.container.redis.set(OUTCOMES_KEY, JSON.stringify(toSave));
    } catch (err) {
      this.container.logger.error({ err }, 'Memory: failed to persist outcomes');
    }
  }

  private async updateStats(): Promise<void> {
    const evaluated = this.outcomes.filter((o) => o.wasCorrect !== undefined);
    if (evaluated.length === 0) return;

    const wins = evaluated.filter((o) => o.wasCorrect).length;
    const losses = evaluated.length - wins;
    const winRate = wins / evaluated.length;
    const avgPnl = evaluated.reduce((sum, o) => sum + (o.pnlPercent ?? 0), 0) / evaluated.length;
    const totalPnlSol = evaluated.reduce((sum, o) => sum + (o.pnlSol ?? 0), 0);

    const stats = {
      totalTrades: evaluated.length,
      wins,
      losses,
      winRate,
      avgPnlPercent: avgPnl,
      totalPnlSol,
      updatedAt: Date.now(),
    };

    await this.container.redis.set(STATS_KEY, JSON.stringify(stats));

    this.container.logger.info(
      { ...stats, avgPnlPercent: avgPnl.toFixed(1), totalPnlSol: totalPnlSol.toFixed(4) },
      'Memory: stats updated',
    );
  }

  // --- Query interface ---

  getOutcomes(): DecisionOutcome[] {
    return [...this.outcomes];
  }

  getRecentOutcomes(limit: number): DecisionOutcome[] {
    return this.outcomes.slice(-limit);
  }

  getOutcomesForMint(mintAddress: string): DecisionOutcome[] {
    return this.outcomes.filter((o) => o.mintAddress === mintAddress);
  }

  getWinRate(): number {
    const evaluated = this.outcomes.filter((o) => o.wasCorrect !== undefined);
    if (evaluated.length === 0) return 0;
    return evaluated.filter((o) => o.wasCorrect).length / evaluated.length;
  }
}

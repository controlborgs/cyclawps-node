import { PublicKey } from '@solana/web3.js';
import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { DeployerScoreEngine } from '../intelligence/deployer-scores.js';
import type { WalletGraph } from '../intelligence/wallet-graph.js';
import type { PatternDatabase } from '../intelligence/pattern-db.js';
import type { PumpFunService } from '../modules/pumpfun/pumpfun.service.js';
import type { LLMClient } from './llm.js';
import { Agent } from './base-agent.js';
import type {
  AgentConfig,
  AgentMessage,
  DeployerProfile,
  NewLaunchSignal,
  TokenAnalysis,
} from './types.js';

interface AnalystQueueItem {
  signal: NewLaunchSignal;
  deployerProfile: DeployerProfile;
  receivedAt: number;
}

export interface AnalystDeps {
  llm: LLMClient;
  deployerScores: DeployerScoreEngine;
  walletGraph: WalletGraph;
  patternDb: PatternDatabase;
  pumpfun: PumpFunService;
}

const SYSTEM_PROMPT = `You are an on-chain analyst agent for Solana tokens launched on PumpFun. Your job is to evaluate new token launches and produce a structured analysis.

You will receive:
- Deployer profile (past launches, rug rate, score)
- Bonding curve state (reserves, progress)
- Wallet graph connections
- Historical pattern matches

Output a JSON object with:
- convictionScore: 0-100 (how confident you are this is a good entry)
- riskProfile: "low" | "medium" | "high" | "extreme"
- recommendedPositionSizeSol: number (0 means skip)
- reasoning: string (1-2 sentences explaining your decision)

Be conservative. A 0% rug rate with 1 launch is less trustworthy than a 5% rug rate with 50 launches. Small sample sizes = high risk. Connected wallet clusters = suspicious. Fast bonding curve progress with low holder count = potential rug.`;

export class AnalystAgent extends Agent {
  private readonly deps: AnalystDeps;
  private readonly queue: AnalystQueueItem[] = [];
  private processing = false;

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: AnalystDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    this.onMessage('new-launch', (msg: AgentMessage) => {
      const { signal, deployerProfile } = msg.payload as {
        signal: NewLaunchSignal;
        deployerProfile: DeployerProfile;
      };

      this.queue.push({
        signal,
        deployerProfile,
        receivedAt: Date.now(),
      });

      this.container.logger.info(
        { mint: signal.mintAddress, queueSize: this.queue.length },
        'Analyst queued launch for analysis',
      );
    });
  }

  protected async onStop(): Promise<void> {
    this.queue.length = 0;
  }

  protected async tick(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    try {
      const item = this.queue.shift();
      if (item) {
        await this.analyze(item);
      }
    } finally {
      this.processing = false;
    }
  }

  private async analyze(item: AnalystQueueItem): Promise<void> {
    const { signal, deployerProfile } = item;
    const mint = new PublicKey(signal.mintAddress);

    this.container.logger.info(
      { mint: signal.mintAddress, deployer: signal.deployer },
      'Analyst starting analysis',
    );

    // Gather context
    let curveState;
    try {
      curveState = await this.deps.pumpfun.getBondingCurveState(mint);
    } catch {
      this.container.logger.warn(
        { mint: signal.mintAddress },
        'Analyst could not fetch bonding curve — skipping',
      );
      return;
    }

    if (curveState.complete) {
      this.container.logger.info(
        { mint: signal.mintAddress },
        'Bonding curve complete — skipping',
      );
      return;
    }

    // Wallet graph context
    const cluster = await this.deps.walletGraph.getCluster(signal.deployer, 2);
    const clusterSize = cluster.length;

    // Check for historical patterns
    const patternContext: Record<string, number> = {
      deployerScore: deployerProfile.score,
      rugRate: deployerProfile.rugRate,
      totalLaunches: deployerProfile.totalLaunches,
      clusterSize,
      bondingCurveProgress:
        Number(curveState.realSolReserves * 100n / (curveState.virtualSolReserves || 1n)),
    };

    const patternMatches = await this.deps.patternDb.findMatches(patternContext);

    // Build LLM context
    const userPrompt = `Analyze this new PumpFun token launch:

## Deployer Profile
- Address: ${signal.deployer}
- Total launches: ${deployerProfile.totalLaunches}
- Rug count: ${deployerProfile.rugCount}
- Rug rate: ${(deployerProfile.rugRate * 100).toFixed(1)}%
- Average token lifespan: ${Math.round(deployerProfile.avgTokenLifespanMs / 60000)} minutes
- Deployer score: ${deployerProfile.score}/100
- Connected wallets in cluster: ${clusterSize}

## Bonding Curve State
- Virtual SOL reserves: ${Number(curveState.virtualSolReserves) / 1e9} SOL
- Virtual token reserves: ${Number(curveState.virtualTokenReserves) / 1e6} tokens
- Real SOL reserves: ${Number(curveState.realSolReserves) / 1e9} SOL
- Real token reserves: ${Number(curveState.realTokenReserves) / 1e6} tokens
- Complete: ${curveState.complete}

## Historical Pattern Matches
${patternMatches.length > 0
  ? patternMatches
      .slice(0, 5)
      .map((m) => `- "${m.patternName}": ${(m.hitRate * 100).toFixed(0)}% hit rate, ${m.avgReturn.toFixed(1)}% avg return, ${m.sampleSize} samples`)
      .join('\n')
  : 'No matching patterns found.'}

## Token
- Mint: ${signal.mintAddress}
- Slot: ${signal.slot}`;

    try {
      const analysis = await this.deps.llm.reasonJSON<{
        convictionScore: number;
        riskProfile: 'low' | 'medium' | 'high' | 'extreme';
        recommendedPositionSizeSol: number;
        reasoning: string;
      }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
      });

      const tokenAnalysis: TokenAnalysis = {
        mintAddress: signal.mintAddress,
        deployer: signal.deployer,
        deployerScore: deployerProfile.score,
        convictionScore: analysis.convictionScore,
        riskProfile: analysis.riskProfile,
        holderConcentration: 0, // TODO: fetch from RPC
        bondingCurveProgress: patternContext['bondingCurveProgress'] ?? 0,
        recommendedPositionSizeSol: analysis.recommendedPositionSizeSol,
        reasoning: analysis.reasoning,
        timestamp: Date.now(),
      };

      this.container.logger.info(
        {
          mint: signal.mintAddress,
          conviction: analysis.convictionScore,
          risk: analysis.riskProfile,
          size: analysis.recommendedPositionSizeSol,
        },
        'Analyst completed analysis',
      );

      // Forward to strategist if conviction is meaningful
      if (analysis.convictionScore > 0 && analysis.recommendedPositionSizeSol > 0) {
        this.sendMessage('strategist', 'token-analysis', tokenAnalysis);
      }
    } catch (err) {
      this.container.logger.error(
        { err, mint: signal.mintAddress },
        'Analyst LLM reasoning failed',
      );
    }
  }
}

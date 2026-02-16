import { PublicKey } from '@solana/web3.js';
import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { IntelBus } from '../intelligence/intel-bus.js';
import type { WalletGraph } from '../intelligence/wallet-graph.js';
import type { StateEngine } from '../modules/state-engine/state-engine.service.js';
import type { PumpFunService } from '../modules/pumpfun/pumpfun.service.js';
import type { LLMClient } from './llm.js';
import { Agent } from './base-agent.js';
import type { AgentConfig, ThreatSignal } from './types.js';

export interface SentinelDeps {
  llm: LLMClient;
  stateEngine: StateEngine;
  walletGraph: WalletGraph;
  intelBus: IntelBus;
  pumpfun: PumpFunService;
}

const THREAT_SYSTEM_PROMPT = `You are a threat assessment agent monitoring Solana token positions. You receive threat signals and must decide whether they warrant action.

Output a JSON object with:
- isThreat: boolean (true if this warrants defensive action)
- severity: "low" | "medium" | "high" | "critical"
- action: "hold" | "partial_exit" | "full_exit"
- sellPercentage: number (0-100, only if action is partial_exit)
- reasoning: string (1-2 sentences)

Be decisive. A dev selling 5% might be noise. A dev selling 30% with a cluster of connected wallets is a rug. LP removal over 50% is almost always a rug. Multiple weak signals compound into strong signals.`;

export class SentinelAgent extends Agent {
  private readonly deps: SentinelDeps;
  private readonly lastCheck = new Map<string, number>();
  // Cache dev wallets per mint (looked up from DB)
  private readonly devWalletCache = new Map<string, string | null>();

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: SentinelDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Listen for rug signals from the network
    this.deps.intelBus.subscribe('rugs', async (signal) => {
      const data = signal.data as { mintAddress: string; type: string };
      this.container.logger.warn(
        { mint: data.mintAddress, type: data.type, fromNode: signal.nodeId },
        'Sentinel received rug signal from network',
      );

      // Check if we have a position in this token
      const positions = this.deps.stateEngine.getPositionsByMint(data.mintAddress);
      const openPositions = positions.filter((p) => p.status === 'OPEN');

      if (openPositions.length > 0) {
        for (const pos of openPositions) {
          this.sendMessage('executor', 'threat-exit', {
            positionId: pos.id,
            mintAddress: data.mintAddress,
            urgency: 'critical',
            action: 'full_exit',
            sellPercentage: 100,
            reasoning: `Network-wide rug signal from ${signal.nodeId}: ${data.type}`,
          });
        }
      }
    });

    this.container.logger.info('Sentinel agent initialized');
  }

  protected async onStop(): Promise<void> {
    this.lastCheck.clear();
    this.devWalletCache.clear();
  }

  protected async tick(): Promise<void> {
    const openPositions = this.deps.stateEngine.getOpenPositions();
    if (openPositions.length === 0) return;

    for (const position of openPositions) {
      const lastChecked = this.lastCheck.get(position.id) ?? 0;
      if (Date.now() - lastChecked < 10_000) continue;
      this.lastCheck.set(position.id, Date.now());

      try {
        await this.monitorPosition(position.id, position.mintAddress);
      } catch (err) {
        this.container.logger.error(
          { err, positionId: position.id },
          'Sentinel position check failed',
        );
      }
    }
  }

  private async monitorPosition(positionId: string, mintAddress: string): Promise<void> {
    const threats: ThreatSignal[] = [];

    // Check 1: Dev wallet activity
    const devWallet = await this.getDevWallet(mintAddress);
    if (devWallet) {
      const sellPct = this.deps.stateEngine.getDevSellPercentageInWindow(
        mintAddress,
        devWallet,
        600_000, // 10 minute window
      );

      if (sellPct > 5) {
        threats.push({
          positionId,
          mintAddress,
          threatType: 'dev_sell',
          severity: sellPct > 30 ? 'critical' : sellPct > 15 ? 'high' : 'medium',
          details: { sellPercentage: sellPct, devWallet },
          timestamp: Date.now(),
        });
      }
    }

    // Check 2: Bonding curve state changes
    try {
      const mint = new PublicKey(mintAddress);
      const curveState = await this.deps.pumpfun.getBondingCurveState(mint);

      if (curveState.complete) {
        threats.push({
          positionId,
          mintAddress,
          threatType: 'volume_anomaly',
          severity: 'high',
          details: { reason: 'Bonding curve completed — migrating to AMM' },
          timestamp: Date.now(),
        });
      }
    } catch {
      // Bonding curve may not exist if already migrated
    }

    // Check 3: Wallet graph changes (new connections to deployer)
    if (devWallet) {
      const clusterSize = await this.deps.walletGraph.getClusterSize(devWallet, 2);
      if (clusterSize > 10) {
        threats.push({
          positionId,
          mintAddress,
          threatType: 'wallet_graph_change',
          severity: 'medium',
          details: { clusterSize, devWallet },
          timestamp: Date.now(),
        });
      }
    }

    if (threats.length === 0) return;

    // Publish threats to intelligence network
    for (const threat of threats) {
      if (threat.severity === 'high' || threat.severity === 'critical') {
        await this.deps.intelBus.publish('rugs', 'threat', {
          mintAddress,
          type: threat.threatType,
          severity: threat.severity,
          details: threat.details,
        });
      }
    }

    // Critical threats — skip LLM, exit immediately
    if (threats.some((t) => t.severity === 'critical')) {
      this.sendMessage('executor', 'threat-exit', {
        positionId,
        mintAddress,
        urgency: 'critical',
        action: 'full_exit',
        sellPercentage: 100,
        reasoning: `Critical threat detected: ${threats.map((t) => t.threatType).join(', ')}`,
      });
      return;
    }

    // Use LLM for nuanced threat assessment
    try {
      const assessment = await this.deps.llm.reasonJSON<{
        isThreat: boolean;
        severity: string;
        action: string;
        sellPercentage: number;
        reasoning: string;
      }>({
        systemPrompt: THREAT_SYSTEM_PROMPT,
        userPrompt: `Position ${positionId} on token ${mintAddress}:

Threat signals detected:
${threats.map((t) => `- ${t.threatType} (${t.severity}): ${JSON.stringify(t.details)}`).join('\n')}

What action should we take?`,
      });

      if (assessment.isThreat && assessment.action !== 'hold') {
        this.sendMessage('executor', 'threat-exit', {
          positionId,
          mintAddress,
          urgency: assessment.severity,
          action: assessment.action,
          sellPercentage: assessment.sellPercentage,
          reasoning: assessment.reasoning,
        });

        this.container.logger.warn(
          {
            positionId,
            mintAddress,
            action: assessment.action,
            reasoning: assessment.reasoning,
          },
          'Sentinel recommending exit',
        );
      }
    } catch (err) {
      this.container.logger.error({ err, positionId }, 'Sentinel LLM assessment failed');

      if (threats.some((t) => t.severity === 'high')) {
        this.sendMessage('executor', 'threat-exit', {
          positionId,
          mintAddress,
          urgency: 'high',
          action: 'full_exit',
          sellPercentage: 100,
          reasoning: 'LLM failed but high-severity threats detected — defensive exit',
        });
      }
    }
  }

  /**
   * Look up the dev wallet for a mint from the tracked_tokens table.
   * Cached to avoid repeated DB queries.
   */
  private async getDevWallet(mintAddress: string): Promise<string | null> {
    if (this.devWalletCache.has(mintAddress)) {
      return this.devWalletCache.get(mintAddress) ?? null;
    }

    const token = await this.container.db.trackedToken.findFirst({
      where: { mintAddress },
      select: { devWallet: true },
    });

    const devWallet = token?.devWallet ?? null;
    this.devWalletCache.set(mintAddress, devWallet);
    return devWallet;
  }
}

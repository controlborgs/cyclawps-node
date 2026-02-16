import { PublicKey } from '@solana/web3.js';
import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { IntelBus } from '../intelligence/intel-bus.js';
import type { DeployerScoreEngine } from '../intelligence/deployer-scores.js';
import type { WalletGraph } from '../intelligence/wallet-graph.js';
import type { PumpFunService } from '../modules/pumpfun/pumpfun.service.js';
import { Agent } from './base-agent.js';
import type { AgentConfig, NewLaunchSignal } from './types.js';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Minimum deployer score to forward to analyst
const MIN_SCORE_FOR_ANALYSIS = 20;

export interface ScoutDeps {
  intelBus: IntelBus;
  deployerScores: DeployerScoreEngine;
  walletGraph: WalletGraph;
  pumpfun: PumpFunService;
}

export class ScoutAgent extends Agent {
  private readonly deps: ScoutDeps;
  private readonly seenMints = new Set<string>();
  private lastSlot = 0;

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: ScoutDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Listen for new launches from the intelligence network
    this.deps.intelBus.subscribe('launches', async (signal) => {
      const data = signal.data as { mintAddress: string; deployer: string };
      if (!this.seenMints.has(data.mintAddress)) {
        this.seenMints.add(data.mintAddress);
        this.container.logger.info(
          { mint: data.mintAddress, fromNode: signal.nodeId },
          'Scout received launch from network',
        );
      }
    });

    this.container.logger.info('Scout agent initialized');
  }

  protected async onStop(): Promise<void> {
    this.seenMints.clear();
  }

  protected async tick(): Promise<void> {
    await this.scanRecentSignatures();
  }

  /**
   * Scan recent Solana signatures for PumpFun program activity.
   * Identifies new token creates by looking for Initialize instructions.
   */
  private async scanRecentSignatures(): Promise<void> {
    const { connection } = this.container.solana;

    try {
      const signatures = await connection.getSignaturesForAddress(
        PUMP_PROGRAM_ID,
        { limit: 25 },
        'confirmed',
      );

      for (const sig of signatures) {
        // Skip already-processed slots
        if (sig.slot <= this.lastSlot) continue;

        // Skip errors
        if (sig.err) continue;

        try {
          await this.processSignature(sig.signature, sig.slot);
        } catch (err) {
          this.container.logger.debug(
            { err, signature: sig.signature },
            'Scout failed to process signature',
          );
        }
      }

      const first = signatures[0];
      if (first && first.slot > this.lastSlot) {
        this.lastSlot = first.slot;
      }
    } catch (err) {
      this.container.logger.error({ err }, 'Scout scan failed');
    }
  }

  private async processSignature(signature: string, slot: number): Promise<void> {
    const { connection } = this.container.solana;

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || tx.meta.err) return;

    // Look for new token mints created by PumpFun
    // PumpFun creates: mint account, bonding curve, associated bonding curve
    const postTokenBalances = tx.meta.postTokenBalances ?? [];

    for (const balance of postTokenBalances) {
      const mintAddress = balance.mint;
      if (this.seenMints.has(mintAddress)) continue;
      this.seenMints.add(mintAddress);

      // Identify deployer (first signer)
      const deployer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey?.toBase58();
      if (!deployer) continue;

      // Check if this mint has a bonding curve (confirms PumpFun launch)
      try {
        const bondingCurve = this.deps.pumpfun.getBondingCurvePDA(new PublicKey(mintAddress));
        const accountInfo = await connection.getAccountInfo(bondingCurve);
        if (!accountInfo) continue; // Not a PumpFun token
      } catch {
        continue;
      }

      await this.handleNewLaunch(mintAddress, deployer, slot, signature);
    }
  }

  private async handleNewLaunch(
    mintAddress: string,
    deployer: string,
    slot: number,
    signature: string,
  ): Promise<void> {
    this.container.logger.info(
      { mintAddress, deployer, slot },
      'Scout detected new PumpFun launch',
    );

    // Get deployer's connected wallets from graph
    const connectedWallets = await this.deps.walletGraph.getConnected(deployer);

    // Record/update deployer profile
    const profile = await this.deps.deployerScores.recordLaunch(
      deployer,
      mintAddress,
      connectedWallets,
    );

    // Add deployer edge to wallet graph
    await this.deps.walletGraph.addEdge(deployer, mintAddress, 'deployed_from');

    // Publish to intelligence network
    await this.deps.intelBus.publish('launches', 'deployer_activity', {
      mintAddress,
      deployer,
      deployerScore: profile.score,
      slot,
      signature,
    });

    // If deployer score meets threshold, send to analyst for deep analysis
    if (profile.score >= MIN_SCORE_FOR_ANALYSIS) {
      const signal: NewLaunchSignal = {
        mintAddress,
        deployer,
        timestamp: Date.now(),
        slot,
        bondingCurveAddress: this.deps.pumpfun
          .getBondingCurvePDA(new PublicKey(mintAddress))
          .toBase58(),
        initialVirtualSol: 0n,
        initialVirtualTokens: 0n,
      };

      this.sendMessage('analyst', 'new-launch', {
        signal,
        deployerProfile: profile,
      });

      this.container.logger.info(
        { mintAddress, deployer, score: profile.score },
        'Scout forwarded launch to Analyst',
      );
    } else {
      this.container.logger.debug(
        { mintAddress, deployer, score: profile.score, threshold: MIN_SCORE_FOR_ANALYSIS },
        'Scout skipped low-score deployer',
      );
    }
  }
}

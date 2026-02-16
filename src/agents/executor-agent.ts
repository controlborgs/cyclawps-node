import { PublicKey } from '@solana/web3.js';
import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { StateEngine } from '../modules/state-engine/state-engine.service.js';
import type { ExecutionEngine } from '../modules/execution-engine/execution-engine.service.js';
import type { RiskEngine } from '../modules/risk-engine/risk-engine.service.js';
import type { PumpFunService } from '../modules/pumpfun/pumpfun.service.js';
import { Agent } from './base-agent.js';
import type { AgentConfig, AgentMessage, ExecutionPlan } from './types.js';

export interface ExecutorDeps {
  stateEngine: StateEngine;
  executionEngine: ExecutionEngine;
  riskEngine: RiskEngine;
  pumpfun: PumpFunService;
}

interface QueuedExecution {
  plan: ExecutionPlan;
  receivedAt: number;
}

export class ExecutorAgent extends Agent {
  private readonly deps: ExecutorDeps;
  private readonly queue: QueuedExecution[] = [];
  private processing = false;

  constructor(container: Container, eventBus: EventBus, config: AgentConfig, deps: ExecutorDeps) {
    super(container, eventBus, config);
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Receive execution plans from Strategist (entries)
    this.onMessage('execution-plan', (msg: AgentMessage) => {
      const plan = msg.payload as ExecutionPlan;
      this.enqueue(plan);
    });

    // Receive threat exits from Sentinel
    this.onMessage('threat-exit', (msg: AgentMessage) => {
      const exit = msg.payload as {
        positionId: string;
        mintAddress: string;
        urgency: string;
        action: string;
        sellPercentage: number;
        reasoning: string;
      };

      const plan: ExecutionPlan = {
        id: `threat-${exit.positionId}-${Date.now()}`,
        action: exit.action === 'full_exit' ? 'exit' : 'partial_exit',
        mintAddress: exit.mintAddress,
        positionId: exit.positionId,
        sellPercentage: exit.sellPercentage,
        maxSlippageBps: this.container.riskParams.maxSlippageBps,
        priorityFeeLamports: this.container.riskParams.maxPriorityFeeLamports,
        urgency: exit.urgency as ExecutionPlan['urgency'],
        reasoning: exit.reasoning,
        timestamp: Date.now(),
      };

      // Critical exits go to front of queue
      if (exit.urgency === 'critical') {
        this.queue.unshift({ plan, receivedAt: Date.now() });
        this.container.logger.warn(
          { positionId: exit.positionId, mint: exit.mintAddress },
          'Executor: critical exit queued at front',
        );
      } else {
        this.enqueue(plan);
      }
    });

    this.container.logger.info('Executor agent initialized');
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
        await this.executePlan(item.plan);
      }
    } finally {
      this.processing = false;
    }
  }

  private enqueue(plan: ExecutionPlan): void {
    // Sort by urgency: critical > high > medium > low
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    this.queue.push({ plan, receivedAt: Date.now() });
    this.queue.sort(
      (a, b) =>
        (urgencyOrder[a.plan.urgency] ?? 3) - (urgencyOrder[b.plan.urgency] ?? 3),
    );

    this.container.logger.info(
      { planId: plan.id, action: plan.action, urgency: plan.urgency, queueSize: this.queue.length },
      'Executor queued plan',
    );
  }

  private async executePlan(plan: ExecutionPlan): Promise<void> {
    this.container.logger.info(
      { planId: plan.id, action: plan.action, mint: plan.mintAddress },
      'Executor processing plan',
    );

    try {
      if (plan.action === 'enter') {
        await this.executeEntry(plan);
      } else if (plan.action === 'exit' || plan.action === 'partial_exit') {
        await this.executeExit(plan);
      } else if (plan.action === 'skip') {
        // Nothing to do
        return;
      }
    } catch (err) {
      this.container.logger.error(
        { err, planId: plan.id, action: plan.action },
        'Executor plan failed',
      );

      // Report failure to memory
      this.sendMessage('memory', 'execution-result', {
        planId: plan.id,
        mintAddress: plan.mintAddress,
        action: plan.action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
  }

  private async executeEntry(plan: ExecutionPlan): Promise<void> {
    if (!plan.solAmount || plan.solAmount <= 0) {
      this.container.logger.warn({ planId: plan.id }, 'Executor: no SOL amount for entry');
      return;
    }

    const mint = new PublicKey(plan.mintAddress);
    const { connection, keypair } = this.container.solana;

    // Get bonding curve state
    const curveState = await this.deps.pumpfun.getBondingCurveState(mint);
    if (curveState.complete) {
      this.container.logger.warn(
        { mint: plan.mintAddress },
        'Executor: bonding curve complete, cannot buy',
      );
      return;
    }

    // Calculate buy quote
    const solLamports = BigInt(Math.round(plan.solAmount * 1e9));
    const quote = this.deps.pumpfun.calculateBuyQuote(curveState, solLamports);
    const maxCost = this.deps.pumpfun.applySlippage(solLamports, plan.maxSlippageBps, true);

    this.container.logger.info(
      {
        mint: plan.mintAddress,
        solAmount: plan.solAmount,
        tokensOut: quote.amountOut.toString(),
        priceImpactBps: quote.priceImpactBps,
      },
      'Executor: building buy TX',
    );

    // Build and send
    const ix = await this.deps.pumpfun.buildBuyInstruction(
      mint,
      keypair.publicKey,
      quote.amountOut,
      maxCost,
    );

    const { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = await import('@solana/web3.js');

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: plan.priorityFeeLamports,
    });

    const blockhash = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [cuLimitIx, cuPriceIx, ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([keypair]);

    // Simulate
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      this.container.logger.error(
        { err: sim.value.err, mint: plan.mintAddress },
        'Executor: buy simulation failed',
      );
      return;
    }

    // Send
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    this.container.logger.info(
      { signature: sig, mint: plan.mintAddress, solAmount: plan.solAmount },
      'Executor: buy TX sent',
    );

    // Report to memory
    this.sendMessage('memory', 'execution-result', {
      planId: plan.id,
      mintAddress: plan.mintAddress,
      action: 'enter',
      success: true,
      signature: sig,
      solAmount: plan.solAmount,
      tokensReceived: quote.amountOut.toString(),
      timestamp: Date.now(),
    });
  }

  private async executeExit(plan: ExecutionPlan): Promise<void> {
    if (!plan.positionId) {
      this.container.logger.warn({ planId: plan.id }, 'Executor: no positionId for exit');
      return;
    }

    const sellPercentage = plan.action === 'exit' ? 100 : (plan.sellPercentage ?? 50);

    const result = await this.deps.executionEngine.execute({
      positionId: plan.positionId,
      policyId: `agent:sentinel:${plan.id}`,
      action: sellPercentage >= 100 ? 'FULL_EXIT' : 'PARTIAL_SELL',
      sellPercentage,
      maxSlippageBps: plan.maxSlippageBps,
      priorityFeeLamports: plan.priorityFeeLamports,
    });

    this.container.logger.info(
      {
        positionId: plan.positionId,
        status: result.status,
        signature: result.txSignature,
      },
      'Executor: exit complete',
    );

    // Report to memory
    this.sendMessage('memory', 'execution-result', {
      planId: plan.id,
      mintAddress: plan.mintAddress,
      positionId: plan.positionId,
      action: plan.action,
      success: result.status === 'CONFIRMED',
      signature: result.txSignature,
      sellPercentage,
      timestamp: Date.now(),
    });
  }
}

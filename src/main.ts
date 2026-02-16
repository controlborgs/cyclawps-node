import { env } from './config/env.js';
import {
  createLogger,
  createRedisClient,
  createPrismaClient,
  createSolanaContext,
  checkRpcHealth,
} from './infra/index.js';
import type { Container } from './infra/container.js';
import { EventBus } from './services/event-bus.js';
import { EventIngestionService } from './modules/event-ingestion/index.js';
import { StateEngine } from './modules/state-engine/index.js';
import { PolicyEngine } from './modules/policy-engine/index.js';
import { RiskEngine } from './modules/risk-engine/index.js';
import { ExecutionEngine } from './modules/execution-engine/index.js';
import { Orchestrator } from './modules/orchestrator/index.js';
import { PumpFunService } from './modules/pumpfun/index.js';
import { createServer } from './api/server.js';

// Agent swarm
import { Swarm, LLMClient } from './agents/index.js';
import { ScoutAgent } from './agents/scout.js';
import { AnalystAgent } from './agents/analyst.js';
import { SentinelAgent } from './agents/sentinel.js';
import { StrategistAgent } from './agents/strategist.js';
import { ExecutorAgent } from './agents/executor-agent.js';
import { MemoryAgent } from './agents/memory-agent.js';

// Intelligence layer
import { IntelBus } from './intelligence/intel-bus.js';
import { DeployerScoreEngine } from './intelligence/deployer-scores.js';
import { WalletGraph } from './intelligence/wallet-graph.js';
import { PatternDatabase } from './intelligence/pattern-db.js';

async function main(): Promise<void> {
  const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: env.NODE_ENV });
  logger.info('CyclAwps starting');

  // Infrastructure
  const db = createPrismaClient(logger);
  await db.$connect();
  logger.info('Database connected');

  const redis = createRedisClient(env.REDIS_URL, logger);
  await redis.connect();
  logger.info('Redis connected');

  const solana = createSolanaContext(env, logger);
  await checkRpcHealth(solana.connection, logger);

  const container: Container = {
    logger,
    db,
    redis,
    solana,
    riskParams: {
      maxPositionSizeSol: env.MAX_POSITION_SIZE_SOL,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      maxPriorityFeeLamports: env.MAX_PRIORITY_FEE_LAMPORTS,
      executionCooldownMs: env.EXECUTION_COOLDOWN_MS,
    },
  };

  // Core services
  const eventBus = new EventBus(logger);
  const stateEngine = new StateEngine(container, eventBus);
  const policyEngine = new PolicyEngine(container, stateEngine, eventBus);
  const pumpfun = new PumpFunService(container);
  const riskEngine = new RiskEngine(container, stateEngine);
  const executionEngine = new ExecutionEngine(container, stateEngine, riskEngine, pumpfun);
  const eventIngestion = new EventIngestionService(container, eventBus);
  const orchestrator = new Orchestrator(
    container,
    eventBus,
    stateEngine,
    policyEngine,
    executionEngine,
  );

  // Start core services
  await stateEngine.start();
  await policyEngine.start();
  await eventIngestion.start();
  await orchestrator.start();

  // --- Agent Swarm ---
  let swarm: Swarm | null = null;

  if (env.SWARM_ENABLED && env.LLM_API_KEY) {
    logger.info('Swarm mode enabled — initializing agents');

    // LLM client
    const llm = new LLMClient(
      {
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        maxTokens: env.LLM_MAX_TOKENS,
      },
      logger,
    );

    // Intelligence layer
    const intelBus = new IntelBus(
      redis,
      { nodeId: env.NODE_ID, channelPrefix: env.INTEL_CHANNEL_PREFIX },
      logger,
    );
    const deployerScores = new DeployerScoreEngine(redis, logger);
    const walletGraph = new WalletGraph(redis, logger);
    const patternDb = new PatternDatabase(redis, logger);

    // Create agents
    const scout = new ScoutAgent(
      container,
      eventBus,
      { role: 'scout', tickIntervalMs: 3000, enabled: true },
      { intelBus, deployerScores, walletGraph, pumpfun },
    );

    const analyst = new AnalystAgent(
      container,
      eventBus,
      { role: 'analyst', tickIntervalMs: 2000, enabled: true },
      { llm, deployerScores, walletGraph, patternDb, pumpfun },
    );

    const sentinel = new SentinelAgent(
      container,
      eventBus,
      { role: 'sentinel', tickIntervalMs: 5000, enabled: true },
      { llm, stateEngine, walletGraph, intelBus, pumpfun },
    );

    const strategist = new StrategistAgent(
      container,
      eventBus,
      { role: 'strategist', tickIntervalMs: 2000, enabled: true },
      { llm, stateEngine, patternDb },
    );

    const executor = new ExecutorAgent(
      container,
      eventBus,
      { role: 'executor', tickIntervalMs: 1000, enabled: true },
      { stateEngine, executionEngine, riskEngine, pumpfun },
    );

    const memory = new MemoryAgent(
      container,
      eventBus,
      { role: 'memory', tickIntervalMs: 10000, enabled: true },
      { patternDb, deployerScores, stateEngine },
    );

    // Assemble swarm
    swarm = new Swarm(logger);
    swarm.register(scout);
    swarm.register(analyst);
    swarm.register(sentinel);
    swarm.register(strategist);
    swarm.register(executor);
    swarm.register(memory);

    // Start intelligence bus and swarm
    await intelBus.startConsuming();
    await swarm.start();

    logger.info(
      { nodeId: env.NODE_ID, agentCount: 6 },
      'Agent swarm operational',
    );
  } else {
    logger.info('Swarm mode disabled — running in policy-only mode');
  }

  // API server
  const server = await createServer({ container, policyEngine, eventIngestion, pumpfun, stateEngine });
  await server.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'API server listening');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');

    await server.close();

    if (swarm) {
      await swarm.stop();
    }

    await orchestrator.stop();
    await eventIngestion.stop();
    await policyEngine.stop();
    await stateEngine.stop();
    await riskEngine.stop();
    await executionEngine.stop();

    redis.disconnect();
    await db.$disconnect();

    logger.info('CyclAwps shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  logger.info('CyclAwps fully operational');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});

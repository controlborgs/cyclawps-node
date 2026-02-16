import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';
import type { DeployerScoreEngine } from '../../intelligence/deployer-scores.js';
import type { PatternDatabase } from '../../intelligence/pattern-db.js';
import type { Swarm } from '../../agents/swarm.js';

export interface MetricsDeps {
  deployerScores: DeployerScoreEngine | null;
  patternDb: PatternDatabase | null;
  swarm: Swarm | null;
}

export async function metricsRoutes(
  app: FastifyInstance,
  container: Container,
  deps: MetricsDeps,
): Promise<void> {
  app.get('/metrics/network', async (_request, reply) => {
    const { redis } = container;
    const { deployerScores, patternDb, swarm } = deps;

    const now = Date.now();
    const dayAgo = now - 86_400_000;

    // Deployers scored (total in sorted set)
    const deployersScored = deployerScores
      ? await deployerScores.getDeployerCount()
      : 0;

    // Wallet graph edges (count edge keys)
    const edgeCursor = await redis.scan(0, 'MATCH', 'cyclawps:graph:edge:*', 'COUNT', 1000);
    const walletGraphEdges = edgeCursor[1].length;

    // Pattern stats
    const patternStats = patternDb ? await patternDb.getStats() : null;

    // Signal stream length (sum across all signal streams)
    const signalKeys = await redis.keys('cyclawps:signals:*');
    let signalsTotal = 0;
    let lastSignalAt: string | null = null;

    for (const key of signalKeys) {
      const len = await redis.xlen(key);
      signalsTotal += len;

      // Get latest entry timestamp
      const latest = await redis.xrevrange(key, '+', '-', 'COUNT', '1');
      if (latest.length > 0 && latest[0]) {
        const [id] = latest[0];
        const ts = parseInt(id.split('-')[0] ?? '0', 10);
        if (!lastSignalAt || ts > new Date(lastSignalAt).getTime()) {
          lastSignalAt = new Date(ts).toISOString();
        }
      }
    }

    // Swarm status
    const swarmStatus = swarm?.getStatus() ?? null;
    const agentsRunning = swarmStatus
      ? swarmStatus.agents.filter((a) => a.running).length
      : 0;

    // Positions tracked
    const openPositions = await container.db.position.count({
      where: { status: 'OPEN' },
    });

    // Events in last 24h
    const recentEvents = await container.db.eventLog.count({
      where: { processedAt: { gte: new Date(dayAgo) } },
    });

    return reply.send({
      timestamp: new Date().toISOString(),
      node: {
        swarmEnabled: swarmStatus?.running ?? false,
        agentsRunning,
        agentCount: swarmStatus?.agentCount ?? 0,
      },
      intelligence: {
        deployersScored,
        walletGraphEdges,
        patternsRecorded: patternStats?.patternCount ?? 0,
        patternOutcomes: patternStats?.totalOutcomes ?? 0,
        signalsTotal,
        lastSignalAt,
      },
      positions: {
        open: openPositions,
      },
      activity: {
        events24h: recentEvents,
      },
    });
  });
}

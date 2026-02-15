import type { Redis } from 'ioredis';
import type { Logger } from '../infra/logger.js';

const KEY_PREFIX = 'cyclawps:graph';
const EDGE_TTL = 604800; // 7 days

export type EdgeType = 'funded_by' | 'transferred_to' | 'deployed_from' | 'associated';

export interface WalletEdge {
  from: string;
  to: string;
  type: EdgeType;
  firstSeen: number;
  lastSeen: number;
  txCount: number;
}

export class WalletGraph {
  private readonly redis: Redis;
  private readonly logger: Logger;

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  // --- Edge management ---

  async addEdge(from: string, to: string, type: EdgeType): Promise<void> {
    const edgeKey = `${KEY_PREFIX}:edge:${from}:${to}`;
    const existing = await this.redis.get(edgeKey);

    let edge: WalletEdge;
    if (existing) {
      edge = JSON.parse(existing) as WalletEdge;
      edge.lastSeen = Date.now();
      edge.txCount += 1;
    } else {
      edge = {
        from,
        to,
        type,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        txCount: 1,
      };
    }

    await this.redis.set(edgeKey, JSON.stringify(edge), 'EX', EDGE_TTL);

    // Maintain adjacency sets for fast lookups
    await this.redis.sadd(`${KEY_PREFIX}:out:${from}`, to);
    await this.redis.expire(`${KEY_PREFIX}:out:${from}`, EDGE_TTL);
    await this.redis.sadd(`${KEY_PREFIX}:in:${to}`, from);
    await this.redis.expire(`${KEY_PREFIX}:in:${to}`, EDGE_TTL);

    this.logger.debug({ from, to, type, txCount: edge.txCount }, 'Wallet edge added');
  }

  async getEdge(from: string, to: string): Promise<WalletEdge | null> {
    const data = await this.redis.get(`${KEY_PREFIX}:edge:${from}:${to}`);
    if (!data) return null;
    return JSON.parse(data) as WalletEdge;
  }

  // --- Graph queries ---

  async getOutgoing(wallet: string): Promise<string[]> {
    return this.redis.smembers(`${KEY_PREFIX}:out:${wallet}`);
  }

  async getIncoming(wallet: string): Promise<string[]> {
    return this.redis.smembers(`${KEY_PREFIX}:in:${wallet}`);
  }

  async getConnected(wallet: string): Promise<string[]> {
    const [outgoing, incoming] = await Promise.all([
      this.getOutgoing(wallet),
      this.getIncoming(wallet),
    ]);
    return [...new Set([...outgoing, ...incoming])];
  }

  /**
   * BFS cluster detection — find all wallets within N hops of a given wallet.
   */
  async getCluster(wallet: string, maxDepth = 2): Promise<string[]> {
    const visited = new Set<string>([wallet]);
    let frontier = [wallet];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextFrontier: string[] = [];

      for (const node of frontier) {
        const connected = await this.getConnected(node);
        for (const neighbor of connected) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    // Remove the starting wallet
    visited.delete(wallet);
    return [...visited];
  }

  /**
   * Check if two wallets are connected within N hops.
   */
  async areConnected(walletA: string, walletB: string, maxDepth = 3): Promise<boolean> {
    const cluster = await this.getCluster(walletA, maxDepth);
    return cluster.includes(walletB);
  }

  async getClusterSize(wallet: string, maxDepth = 2): Promise<number> {
    const cluster = await this.getCluster(wallet, maxDepth);
    return cluster.length;
  }
}

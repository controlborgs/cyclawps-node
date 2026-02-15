import type { Redis } from 'ioredis';
import type { Logger } from '../infra/logger.js';
import type { DeployerProfile } from '../agents/types.js';

const KEY_PREFIX = 'cyclawps:deployer';
const SCORE_TTL = 86400; // 24 hours

export class DeployerScoreEngine {
  private readonly redis: Redis;
  private readonly logger: Logger;

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  // --- Score computation ---

  computeScore(profile: Omit<DeployerProfile, 'score'>): number {
    // Base score: 50 (neutral)
    let score = 50;

    // Rug rate penalty: -40 at 100% rug rate
    score -= profile.rugRate * 40;

    // Launch count bonus: more launches = more data = more trust (up to +15)
    score += Math.min(15, profile.totalLaunches * 1.5);

    // Token lifespan bonus: longer average life = more trust (up to +20)
    const lifespanHours = profile.avgTokenLifespanMs / (1000 * 60 * 60);
    score += Math.min(20, lifespanHours * 2);

    // Connected wallets penalty: more connections = more suspicious (up to -15)
    score -= Math.min(15, profile.connectedWallets.length * 3);

    // Recency decay: if not seen in 7+ days, reduce trust
    const daysSinceLastSeen = (Date.now() - profile.lastSeen) / (1000 * 60 * 60 * 24);
    if (daysSinceLastSeen > 7) {
      score -= Math.min(10, (daysSinceLastSeen - 7) * 0.5);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // --- Storage ---

  async getProfile(address: string): Promise<DeployerProfile | null> {
    const data = await this.redis.get(`${KEY_PREFIX}:${address}`);
    if (!data) return null;
    return JSON.parse(data) as DeployerProfile;
  }

  async setProfile(profile: DeployerProfile): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}:${profile.address}`,
      JSON.stringify(profile),
      'EX',
      SCORE_TTL,
    );

    // Also maintain a sorted set for leaderboard queries
    await this.redis.zadd(`${KEY_PREFIX}:scores`, String(profile.score), profile.address);
  }

  async recordLaunch(
    deployer: string,
    mintAddress: string,
    connectedWallets: string[],
  ): Promise<DeployerProfile> {
    const existing = await this.getProfile(deployer);

    const profile: Omit<DeployerProfile, 'score'> = {
      address: deployer,
      totalLaunches: (existing?.totalLaunches ?? 0) + 1,
      rugCount: existing?.rugCount ?? 0,
      rugRate: existing?.rugRate ?? 0,
      avgTokenLifespanMs: existing?.avgTokenLifespanMs ?? 0,
      connectedWallets: [
        ...new Set([...(existing?.connectedWallets ?? []), ...connectedWallets]),
      ],
      lastSeen: Date.now(),
    };

    const score = this.computeScore(profile);
    const full: DeployerProfile = { ...profile, score };

    await this.setProfile(full);

    this.logger.info(
      { deployer, score, totalLaunches: full.totalLaunches, mintAddress },
      'Deployer profile updated',
    );

    return full;
  }

  async recordRug(deployer: string, tokenLifespanMs: number): Promise<void> {
    const profile = await this.getProfile(deployer);
    if (!profile) return;

    profile.rugCount += 1;
    profile.rugRate = profile.rugCount / profile.totalLaunches;
    profile.avgTokenLifespanMs =
      (profile.avgTokenLifespanMs * (profile.totalLaunches - 1) + tokenLifespanMs) /
      profile.totalLaunches;
    profile.score = this.computeScore(profile);

    await this.setProfile(profile);

    this.logger.warn(
      { deployer, rugCount: profile.rugCount, rugRate: profile.rugRate, score: profile.score },
      'Rug recorded for deployer',
    );
  }

  // --- Queries ---

  async getTopDeployers(limit: number): Promise<string[]> {
    return this.redis.zrevrange(`${KEY_PREFIX}:scores`, 0, limit - 1);
  }

  async getBottomDeployers(limit: number): Promise<string[]> {
    return this.redis.zrange(`${KEY_PREFIX}:scores`, 0, limit - 1);
  }

  async getDeployerCount(): Promise<number> {
    return this.redis.zcard(`${KEY_PREFIX}:scores`);
  }
}

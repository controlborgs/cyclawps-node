import type { Redis } from 'ioredis';
import type { Logger } from '../infra/logger.js';

const KEY_PREFIX = 'cyclawps:patterns';

export interface Pattern {
  id: string;
  name: string;
  conditions: PatternCondition[];
  outcomeCount: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  avgReturnPercent: number;
  avgHoldDurationMs: number;
  lastMatchedAt: number;
  createdAt: number;
}

export interface PatternCondition {
  field: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte' | 'between';
  value: number | [number, number];
}

export interface PatternMatch {
  patternId: string;
  patternName: string;
  hitRate: number; // positive / total outcomes
  avgReturn: number;
  sampleSize: number;
}

export class PatternDatabase {
  private readonly redis: Redis;
  private readonly logger: Logger;

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  // --- Pattern storage ---

  async savePattern(pattern: Pattern): Promise<void> {
    await this.redis.hset(
      `${KEY_PREFIX}:all`,
      pattern.id,
      JSON.stringify(pattern),
    );
  }

  async getPattern(id: string): Promise<Pattern | null> {
    const data = await this.redis.hget(`${KEY_PREFIX}:all`, id);
    if (!data) return null;
    return JSON.parse(data) as Pattern;
  }

  async getAllPatterns(): Promise<Pattern[]> {
    const all = await this.redis.hgetall(`${KEY_PREFIX}:all`);
    return Object.values(all).map((v) => JSON.parse(v) as Pattern);
  }

  // --- Outcome recording ---

  async recordOutcome(
    patternId: string,
    positive: boolean,
    returnPercent: number,
    holdDurationMs: number,
  ): Promise<void> {
    const pattern = await this.getPattern(patternId);
    if (!pattern) return;

    pattern.outcomeCount += 1;
    if (positive) {
      pattern.positiveOutcomes += 1;
    } else {
      pattern.negativeOutcomes += 1;
    }

    // Rolling average
    pattern.avgReturnPercent =
      (pattern.avgReturnPercent * (pattern.outcomeCount - 1) + returnPercent) /
      pattern.outcomeCount;
    pattern.avgHoldDurationMs =
      (pattern.avgHoldDurationMs * (pattern.outcomeCount - 1) + holdDurationMs) /
      pattern.outcomeCount;
    pattern.lastMatchedAt = Date.now();

    await this.savePattern(pattern);

    this.logger.info(
      {
        patternId,
        positive,
        hitRate: pattern.positiveOutcomes / pattern.outcomeCount,
        sampleSize: pattern.outcomeCount,
      },
      'Pattern outcome recorded',
    );
  }

  // --- Pattern matching ---

  matchCondition(condition: PatternCondition, value: number): boolean {
    switch (condition.operator) {
      case 'gt':
        return value > (condition.value as number);
      case 'lt':
        return value < (condition.value as number);
      case 'eq':
        return value === (condition.value as number);
      case 'gte':
        return value >= (condition.value as number);
      case 'lte':
        return value <= (condition.value as number);
      case 'between': {
        const [low, high] = condition.value as [number, number];
        return value >= low && value <= high;
      }
      default:
        return false;
    }
  }

  async findMatches(context: Record<string, number>): Promise<PatternMatch[]> {
    const patterns = await this.getAllPatterns();
    const matches: PatternMatch[] = [];

    for (const pattern of patterns) {
      // Skip patterns with too few samples
      if (pattern.outcomeCount < 3) continue;

      const allMatch = pattern.conditions.every((cond) => {
        const value = context[cond.field];
        if (value === undefined) return false;
        return this.matchCondition(cond, value);
      });

      if (allMatch) {
        matches.push({
          patternId: pattern.id,
          patternName: pattern.name,
          hitRate: pattern.positiveOutcomes / pattern.outcomeCount,
          avgReturn: pattern.avgReturnPercent,
          sampleSize: pattern.outcomeCount,
        });
      }
    }

    // Sort by sample size * hit rate (signal strength)
    matches.sort((a, b) => b.sampleSize * b.hitRate - a.sampleSize * a.hitRate);

    return matches;
  }

  // --- Stats ---

  async getStats(): Promise<PatternStats> {
    const patterns = await this.getAllPatterns();
    const totalOutcomes = patterns.reduce((sum, p) => sum + p.outcomeCount, 0);
    const avgHitRate =
      patterns.length > 0
        ? patterns.reduce(
            (sum, p) => sum + (p.outcomeCount > 0 ? p.positiveOutcomes / p.outcomeCount : 0),
            0,
          ) / patterns.length
        : 0;

    return {
      patternCount: patterns.length,
      totalOutcomes,
      avgHitRate,
      topPatterns: patterns
        .filter((p) => p.outcomeCount >= 5)
        .sort(
          (a, b) =>
            b.positiveOutcomes / b.outcomeCount -
            a.positiveOutcomes / a.outcomeCount,
        )
        .slice(0, 10)
        .map((p) => ({
          name: p.name,
          hitRate: p.positiveOutcomes / p.outcomeCount,
          avgReturn: p.avgReturnPercent,
          sampleSize: p.outcomeCount,
        })),
    };
  }
}

export interface PatternStats {
  patternCount: number;
  totalOutcomes: number;
  avgHitRate: number;
  topPatterns: {
    name: string;
    hitRate: number;
    avgReturn: number;
    sampleSize: number;
  }[];
}

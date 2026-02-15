import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from '../infra/logger.js';
import type { Signal } from '../agents/types.js';

const STREAM_MAX_LEN = 10000;
const CONSUMER_GROUP = 'cyclawps';
const BLOCK_MS = 2000;

export interface IntelBusConfig {
  nodeId: string;
  channelPrefix: string;
}

export class IntelBus {
  private readonly redis: Redis;
  private readonly publisher: Redis;
  private readonly logger: Logger;
  private readonly nodeId: string;
  private readonly prefix: string;

  private readonly handlers = new Map<string, ((signal: Signal) => void | Promise<void>)[]>();
  private consuming = false;
  private consumeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(redis: Redis, config: IntelBusConfig, logger: Logger) {
    // Use separate connection for blocking reads
    this.redis = redis.duplicate();
    this.publisher = redis;
    this.logger = logger;
    this.nodeId = config.nodeId;
    this.prefix = config.channelPrefix;
  }

  private streamKey(channel: string): string {
    return `${this.prefix}:signals:${channel}`;
  }

  // --- Publishing ---

  async publish(channel: string, type: Signal['type'], data: Record<string, unknown>): Promise<void> {
    const signal: Signal = {
      id: randomUUID(),
      nodeId: this.nodeId,
      type,
      data,
      timestamp: Date.now(),
    };

    const key = this.streamKey(channel);

    await this.publisher.xadd(
      key,
      'MAXLEN',
      '~',
      String(STREAM_MAX_LEN),
      '*',
      'payload',
      JSON.stringify(signal),
    );

    this.logger.debug({ channel, type, nodeId: this.nodeId }, 'Signal published');
  }

  // --- Subscribing ---

  subscribe(channel: string, handler: (signal: Signal) => void | Promise<void>): void {
    const existing = this.handlers.get(channel) ?? [];
    existing.push(handler);
    this.handlers.set(channel, existing);
  }

  async startConsuming(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;

    // Ensure consumer groups exist for all subscribed channels
    for (const channel of this.handlers.keys()) {
      const key = this.streamKey(channel);
      try {
        await this.redis.xgroup('CREATE', key, CONSUMER_GROUP, '0', 'MKSTREAM');
      } catch {
        // Group already exists
      }
    }

    this.logger.info(
      { channels: [...this.handlers.keys()], nodeId: this.nodeId },
      'IntelBus consuming',
    );

    // Poll loop
    this.consumeTimer = setInterval(() => {
      void this.consumeTick();
    }, 500);
  }

  private async consumeTick(): Promise<void> {
    if (!this.consuming) return;

    const streams = [...this.handlers.keys()].map((ch) => this.streamKey(ch));
    if (streams.length === 0) return;

    try {
      const results = await this.redis.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        this.nodeId,
        'COUNT',
        '50',
        'BLOCK',
        String(BLOCK_MS),
        'STREAMS',
        ...streams,
        ...streams.map(() => '>'),
      );

      if (!results) return;

      for (const result of results as [string, [string, string[]][]][]) {
        const [streamKey, messages] = result;
        // Extract channel name from stream key
        const channel = String(streamKey).replace(`${this.prefix}:signals:`, '');
        const handlers = this.handlers.get(channel) ?? [];

        for (const [messageId, fields] of messages) {
          try {
            const payloadIdx = fields.indexOf('payload');
            if (payloadIdx === -1) continue;

            const payloadStr = fields[payloadIdx + 1];
            if (!payloadStr) continue;
            const signal = JSON.parse(payloadStr) as Signal;

            // Skip our own signals
            if (signal.nodeId === this.nodeId) {
              await this.redis.xack(String(streamKey), CONSUMER_GROUP, String(messageId));
              continue;
            }

            for (const handler of handlers) {
              await handler(signal);
            }

            await this.redis.xack(String(streamKey), CONSUMER_GROUP, String(messageId));
          } catch (err) {
            this.logger.error({ err, messageId, channel }, 'Failed to process signal');
          }
        }
      }
    } catch (err) {
      if (this.consuming) {
        this.logger.error({ err }, 'IntelBus consume error');
      }
    }
  }

  async stop(): Promise<void> {
    this.consuming = false;
    if (this.consumeTimer) {
      clearInterval(this.consumeTimer);
      this.consumeTimer = null;
    }
    this.redis.disconnect();
    this.logger.info('IntelBus stopped');
  }
}

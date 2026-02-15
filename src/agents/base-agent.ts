import { randomUUID } from 'node:crypto';
import type { Container } from '../infra/container.js';
import type { EventBus } from '../services/event-bus.js';
import type { AgentConfig, AgentMessage, AgentRole } from './types.js';

export abstract class Agent {
  readonly role: AgentRole;
  protected readonly container: Container;
  protected readonly eventBus: EventBus;
  protected readonly config: AgentConfig;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickCount = 0;
  private lastTickAt = 0;
  private messageHandlers = new Map<string, (msg: AgentMessage) => void | Promise<void>>();

  constructor(container: Container, eventBus: EventBus, config: AgentConfig) {
    this.container = container;
    this.eventBus = eventBus;
    this.config = config;
    this.role = config.role;
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.container.logger.info({ agent: this.role }, 'Agent starting');

    await this.onStart();

    this.timer = setInterval(async () => {
      if (!this.running) return;

      try {
        this.tickCount++;
        this.lastTickAt = Date.now();
        await this.tick();
      } catch (err) {
        this.container.logger.error(
          { agent: this.role, err, tickCount: this.tickCount },
          'Agent tick error',
        );
      }
    }, this.config.tickIntervalMs);

    this.container.logger.info(
      { agent: this.role, tickIntervalMs: this.config.tickIntervalMs },
      'Agent started',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.messageHandlers.clear();
    await this.onStop();

    this.container.logger.info(
      { agent: this.role, totalTicks: this.tickCount },
      'Agent stopped',
    );
  }

  // --- Abstract methods for subclasses ---

  protected abstract tick(): Promise<void>;
  protected abstract onStart(): Promise<void>;
  protected abstract onStop(): Promise<void>;

  // --- Inter-agent messaging ---

  protected sendMessage<T>(to: AgentRole | 'broadcast', channel: string, payload: T): void {
    const msg: AgentMessage<T> = {
      id: randomUUID(),
      from: this.role,
      to,
      channel,
      payload,
      timestamp: Date.now(),
    };

    this.eventBus.emitAgentMessage(msg);
  }

  protected onMessage(channel: string, handler: (msg: AgentMessage) => void | Promise<void>): void {
    this.messageHandlers.set(channel, handler);
    this.eventBus.onAgentMessage(this.role, channel, handler);
  }

  // --- Status ---

  getStatus(): AgentStatus {
    return {
      role: this.role,
      running: this.running,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      uptime: this.running ? Date.now() - (this.lastTickAt - this.tickCount * this.config.tickIntervalMs) : 0,
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

export interface AgentStatus {
  role: AgentRole;
  running: boolean;
  tickCount: number;
  lastTickAt: number;
  uptime: number;
}

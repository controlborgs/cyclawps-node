import { EventEmitter } from 'node:events';
import type { InternalEvent } from '../types/events.js';
import type { Logger } from '../infra/logger.js';
import type { AgentMessage, AgentRole } from '../agents/types.js';

type EventHandler = (event: InternalEvent) => void | Promise<void>;
type AgentMessageHandler = (msg: AgentMessage) => void | Promise<void>;

export class EventBus {
  private readonly emitter: EventEmitter;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.logger = logger;
  }

  // --- On-chain events ---

  emit(event: InternalEvent): void {
    this.logger.debug({ eventType: event.type, eventId: event.id }, 'Event emitted');
    this.emitter.emit('event', event);
    this.emitter.emit(event.type, event);
  }

  on(handler: EventHandler): void {
    this.emitter.on('event', handler);
  }

  onType(type: InternalEvent['type'], handler: EventHandler): void {
    this.emitter.on(type, handler);
  }

  off(handler: EventHandler): void {
    this.emitter.off('event', handler);
  }

  // --- Agent messaging ---

  emitAgentMessage(msg: AgentMessage): void {
    this.logger.debug(
      { from: msg.from, to: msg.to, channel: msg.channel },
      'Agent message',
    );

    // Deliver to specific agent or broadcast
    if (msg.to === 'broadcast') {
      this.emitter.emit('agent:broadcast', msg);
      this.emitter.emit(`agent:broadcast:${msg.channel}`, msg);
    } else {
      this.emitter.emit(`agent:${msg.to}:${msg.channel}`, msg);
    }
  }

  onAgentMessage(role: AgentRole, channel: string, handler: AgentMessageHandler): void {
    this.emitter.on(`agent:${role}:${channel}`, handler);
    this.emitter.on(`agent:broadcast:${channel}`, handler);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

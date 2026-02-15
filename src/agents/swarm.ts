import type { Logger } from '../infra/logger.js';
import type { Agent, AgentStatus } from './base-agent.js';
import type { AgentRole } from './types.js';

export class Swarm {
  private readonly agents = new Map<AgentRole, Agent>();
  private readonly logger: Logger;
  private running = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(agent: Agent): void {
    if (this.agents.has(agent.role)) {
      throw new Error(`Agent with role "${agent.role}" already registered`);
    }
    this.agents.set(agent.role, agent);
    this.logger.info({ agent: agent.role }, 'Agent registered with swarm');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.logger.info(
      { agentCount: this.agents.size, agents: [...this.agents.keys()] },
      'Swarm starting',
    );

    // Start agents in parallel — they're independent
    const startPromises = [...this.agents.values()].map(async (agent) => {
      try {
        await agent.start();
      } catch (err) {
        this.logger.error({ agent: agent.role, err }, 'Failed to start agent');
      }
    });

    await Promise.all(startPromises);

    this.logger.info({ agentCount: this.agents.size }, 'Swarm started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.logger.info('Swarm stopping');

    const stopPromises = [...this.agents.values()].map(async (agent) => {
      try {
        await agent.stop();
      } catch (err) {
        this.logger.error({ agent: agent.role, err }, 'Failed to stop agent');
      }
    });

    await Promise.all(stopPromises);

    this.logger.info('Swarm stopped');
  }

  async pauseAgent(role: AgentRole): Promise<void> {
    const agent = this.agents.get(role);
    if (!agent) throw new Error(`Agent "${role}" not found`);
    await agent.stop();
    this.logger.info({ agent: role }, 'Agent paused');
  }

  async resumeAgent(role: AgentRole): Promise<void> {
    const agent = this.agents.get(role);
    if (!agent) throw new Error(`Agent "${role}" not found`);
    await agent.start();
    this.logger.info({ agent: role }, 'Agent resumed');
  }

  getAgent(role: AgentRole): Agent | undefined {
    return this.agents.get(role);
  }

  getStatus(): SwarmStatus {
    const agents: AgentStatus[] = [];
    for (const agent of this.agents.values()) {
      agents.push(agent.getStatus());
    }
    return {
      running: this.running,
      agentCount: this.agents.size,
      agents,
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

export interface SwarmStatus {
  running: boolean;
  agentCount: number;
  agents: AgentStatus[];
}

import { AgentNotFoundError, DuplicateAgentError } from '../errors/index.js';
import type { Agent } from '../agent.js';

/** Registers agent implementations. Generic: one default agent plus a
 * mock/test agent is sufficient; no autonomous agent personalities. */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (typeof agent.id !== 'string' || agent.id.length === 0) {
      throw new Error('Agent id must be a non-empty string.');
    }
    if (typeof agent.execute !== 'function') {
      throw new Error(`Agent "${agent.id}" must implement execute().`);
    }
    if (this.agents.has(agent.id)) {
      throw new DuplicateAgentError(agent.id);
    }
    this.agents.set(agent.id, agent);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  get(id: string): Agent {
    const agent = this.agents.get(id);
    if (agent === undefined) {
      throw new AgentNotFoundError(id);
    }
    return agent;
  }

  list(): readonly Agent[] {
    return [...this.agents.values()];
  }

  unregister(id: string): void {
    if (!this.agents.has(id)) {
      throw new AgentNotFoundError(id);
    }
    this.agents.delete(id);
  }

  get size(): number {
    return this.agents.size;
  }
}

/** Used by list endpoints: safe agent metadata only. */
export function agentListEntry(agent: Agent): {
  id: string;
  displayName: string;
  description: string;
} {
  return {
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description,
  };
}

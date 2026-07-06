import { EventEmitter } from "events";
import type { OpenCodeClient } from "../bridge/openCodeClient";
import type { AgentInfo } from "../bridge/types";

/**
 * Internal/technical agents used by the server for machinery (title generation,
 * summarization, compaction) that should never be user-selectable.
 * Matched case-insitively against the agent name.
 */
const INTERNAL_AGENT_NAMES = new Set<string>([
  "title",
  "summary",
  "compaction",
  "titler",
  "summarizer",
]);

export class AgentService extends EventEmitter {
  private readonly client: OpenCodeClient;
  private agents: AgentInfo[] = [];
  private selectedAgent: string | null = null;

  constructor(client: OpenCodeClient) {
    super();
    this.client = client;
  }

  getAgents(): AgentInfo[] {
    return this.agents;
  }

  getSelectedAgent(): string | null {
    return this.selectedAgent;
  }

  selectAgent(name: string | null): void {
    this.selectedAgent = name;
    this.emit("agentChanged");
  }

  async refresh(): Promise<void> {
    const agents = await this.client.listAgents();
    this.agents = agents.filter((a) => !INTERNAL_AGENT_NAMES.has(a.name.toLowerCase()));
    this.emit("agentsChanged");
  }
}

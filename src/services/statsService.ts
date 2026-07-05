import type { SessionWithMeta } from "../bridge/types";

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
}

export class StatsService {
  private totalCost = 0;
  private totalTokens: TokenTotals = { input: 0, output: 0, reasoning: 0 };

  update(sessions: SessionWithMeta[]): void {
    let cost = 0;
    const tokens: TokenTotals = { input: 0, output: 0, reasoning: 0 };

    for (const session of sessions) {
      if (typeof session.cost === "number") {
        cost += session.cost;
      }
      if (session.tokens) {
        tokens.input += session.tokens.input;
        tokens.output += session.tokens.output;
        tokens.reasoning += session.tokens.reasoning;
      }
    }

    this.totalCost = cost;
    this.totalTokens = tokens;
  }

  getTotalCost(): number {
    return this.totalCost;
  }

  getTotalTokens(): TokenTotals {
    return this.totalTokens;
  }
}

export function formatCost(cost: number): string {
  if (!cost || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

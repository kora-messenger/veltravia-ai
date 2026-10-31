/**
 * Reasoning observability. One record per run: which provider and model
 * answered, whether it succeeded, the token counts the provider actually
 * reported, latency, iterations, tool calls and the failure category.
 *
 * Nothing here is estimated. When a provider does not report tokens the field
 * stays null rather than being guessed, and no cost is ever invented.
 */

import { scrubReasoningText } from './errors.js';
import type { ReasoningRun, ReasoningUsage } from './engine.js';

export interface ReasoningUsageRecord {
  readonly runId: string;
  readonly profile: string;
  readonly status: ReasoningRun['status'];
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
  readonly simulated: boolean;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Provider-reported wall time for the model calls, plus the run's own. */
  readonly providerLatencyMs: number;
  readonly latencyMs: number;
  readonly failureCategory: string | null;
  readonly taskChars: number;
  readonly createdAt: string;
}

export interface ReasoningUsageStore {
  record(entry: ReasoningUsageRecord): Promise<void> | void;
  list(limit: number): Promise<readonly ReasoningUsageRecord[]> | readonly ReasoningUsageRecord[];
}

/** In-process history. Restarting the API clears it - documented, not hidden. */
export class InMemoryReasoningUsageStore implements ReasoningUsageStore {
  private readonly entries: ReasoningUsageRecord[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = Math.max(1, limit);
  }

  record(entry: ReasoningUsageRecord): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }

  list(limit: number): readonly ReasoningUsageRecord[] {
    return this.entries.slice(0, Math.min(Math.max(limit, 1), this.limit));
  }
}

/** Builds the usage record from a finished run. Never invents token counts. */
export function reasoningUsageRecord(run: ReasoningRun): ReasoningUsageRecord {
  const usage: ReasoningUsage = run.usage;
  return {
    runId: run.id,
    profile: run.profile,
    status: run.status,
    providerId: run.provider?.providerId ?? null,
    modelId: run.provider?.modelId ?? null,
    live: run.provider?.live ?? false,
    simulated: run.provider?.simulated ?? false,
    iterations: usage.iterations,
    toolCalls: usage.toolCalls,
    modelCalls: usage.modelCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    providerLatencyMs: usage.providerLatencyMs,
    latencyMs: usage.latencyMs,
    failureCategory: run.error?.code ?? null,
    taskChars: run.task.length,
    createdAt: run.createdAt,
  };
}

/**
 * A short, safe trace summary for the UI and audit trail: what was decided and
 * which tools ran, never hidden reasoning.
 */
export function reasoningSummaryLine(run: ReasoningRun): string {
  const provider = run.provider
    ? `${run.provider.providerId}/${run.provider.modelId}${run.provider.live ? '' : ' (simulated)'}`
    : 'no provider';
  const parts = [
    `${run.profile} run`,
    provider,
    `${run.usage.iterations} iteration${run.usage.iterations === 1 ? '' : 's'}`,
    `${run.usage.toolCalls} tool call${run.usage.toolCalls === 1 ? '' : 's'}`,
    run.status,
  ];
  return scrubReasoningText(parts.join(' · '));
}

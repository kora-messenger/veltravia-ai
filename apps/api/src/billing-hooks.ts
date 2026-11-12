/**
 * Run billing hooks (Step 57).
 *
 * Some billable operations open their hold in one place (the route that accepts
 * the request) and finish somewhere else entirely (an engine callback, a stream
 * closing, a worker being reviewed). This tracker is the small piece of state
 * between those two moments, so a settled run cannot be settled twice and a
 * cancelled one cannot keep its hold.
 *
 * It is intentionally tiny and in-memory: the authoritative record is the charge
 * row and the wallet ledger, both durable. If the process dies, the scheduled
 * sweep releases whatever is still held - which is the correct outcome for work
 * that was never measured.
 */

import type { BillingHandle } from './unified-billing.js';

export interface RunBillingOutcome {
  /** The engine's terminal status, used only to decide settle vs release. */
  readonly status: string;
  readonly usage?: {
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly cachedTokens?: number | null;
    readonly toolCalls?: number | null;
    readonly durationMs?: number | null;
    readonly modelId?: string | null;
    readonly providerId?: string | null;
  };
  /** When true the hold goes back untouched. */
  readonly releaseReason?: string | null;
}

export interface BilledRunTracker {
  /** Remembers the hold for a run id. A second call replaces nothing. */
  track(runId: string, handle: BillingHandle): void;
  /** Records the run's measured usage and closes its charge. Idempotent. */
  settle(runId: string, outcome: RunBillingOutcome): Promise<void>;
  /** Returns the hold for a run that will never be charged. Idempotent. */
  release(runId: string, reason: string): Promise<void>;
  /** Runs currently holding credit in this process. */
  open(): readonly string[];
}

const TERMINAL_RELEASE = new Set(['cancelled', 'failed', 'timed_out', 'expired', 'refused']);

export function createBilledRunTracker(): BilledRunTracker {
  const holds = new Map<string, BillingHandle>();
  const closed = new Set<string>();

  const finish = async (runId: string, outcome: RunBillingOutcome): Promise<void> => {
    const handle = holds.get(runId);
    if (handle === undefined) return;
    // A run can be observed terminal twice (a poll and a callback); the charge
    // must not settle twice, and operation billing would refuse the second one
    // anyway. Closing once here keeps the intent obvious.
    if (closed.has(runId)) return;
    closed.add(runId);
    holds.delete(runId);
    const failed = TERMINAL_RELEASE.has(outcome.status);
    const reason = outcome.releaseReason ?? null;
    if (reason !== null || failed) {
      await handle
        .release(reason ?? `The run ended as ${outcome.status} and was not charged.`)
        .catch(() => undefined);
      return;
    }
    const usage = outcome.usage;
    if (usage !== undefined) {
      handle.record({
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.cachedTokens === undefined ? {} : { cachedInputTokens: usage.cachedTokens }),
        ...(usage.toolCalls === undefined ? {} : { toolCalls: usage.toolCalls }),
        ...(usage.durationMs === undefined ? {} : { durationMs: usage.durationMs }),
        ...(usage.modelId === undefined ? {} : { modelId: usage.modelId }),
        ...(usage.providerId === undefined ? {} : { providerId: usage.providerId }),
      });
    }
    await handle.settle().catch(() => undefined);
  };

  return {
    track(runId, handle) {
      if (holds.has(runId) || closed.has(runId)) return;
      holds.set(runId, handle);
    },
    settle: finish,
    async release(runId, reason) {
      await finish(runId, { status: 'cancelled', releaseReason: reason });
    },
    open: () => [...holds.keys()],
  };
}

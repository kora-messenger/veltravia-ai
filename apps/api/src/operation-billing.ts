/**
 * Operation billing (Step 55).
 *
 * One billable *operation* - a coding run, an agent execution, a delegated
 * sub-agent - makes many provider calls. Step 54 charges one interaction, so the
 * operation is the unit: a hold is taken before the first model call, every call
 * reported against that operation is added up, and one settlement charges the
 * total.
 *
 * Three properties this file exists to guarantee:
 *
 *  - one charge per operation, whatever the number of model calls. The charge is
 *    found by an idempotency key derived from the operation id, so a retried
 *    request, a resumed run or a duplicated callback lands on the same row;
 *  - no charge without a measurement, and no invented number: an operation that
 *    reported nothing is settled with an honest "unavailable" measurement;
 *  - an abandoned operation leaves the ledger clean. A settlement that fails, or
 *    an operation that never settles, ends with its hold swept - the in-memory
 *    tally is a cache, never a second ledger.
 *
 * The tally is deliberately in memory. If the process dies mid-operation the
 * hold is still in Postgres and the existing sweep releases it; a durable tally
 * would be a second place where usage is recorded, and Step 52 already owns that.
 */

import type { InteractionKind } from '@veltravia/message-credits-core';

import type { MessageCreditService } from './message-credit-service.js';

/** Tokens as providers report them: absent means the provider said nothing. */
export interface OperationUsage {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly toolCalls?: number | null;
  readonly durationMs?: number | null;
  readonly modelId?: string | null;
  readonly providerId?: string | null;
}

export interface OperationRef {
  readonly ownerRef: string;
  readonly kind: InteractionKind;
  /** Stable id for this operation: the coding run id, the worker id, the task id. */
  readonly operationId: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  /** Set when this operation is work delegated by another billable operation. */
  readonly parentChargeId?: string | null;
  readonly byok?: boolean;
}

export interface OperationTally {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  toolCalls: number | null;
  durationMs: number;
  calls: number;
  modelId: string | null;
  providerId: string | null;
}

export interface OperationLedger {
  readonly key: string;
  readonly ref: OperationRef;
  readonly chargeId: string | null;
  readonly exempt: boolean;
  /** Adds one reported call to the tally. Missing numbers stay missing. */
  record(usage: OperationUsage): void;
  /** Sum of what has been reported so far, without settling. */
  tally(): OperationTally;
}

export interface OperationSettlement {
  readonly settled: boolean;
  readonly chargeId: string | null;
  readonly credits: number;
  readonly calls: number;
  readonly reason: string | null;
}

export interface OperationBilling {
  begin(ref: OperationRef): Promise<OperationLedger>;
  record(ref: OperationRef, usage: OperationUsage): void;
  settle(ref: OperationRef): Promise<OperationSettlement>;
  abandon(ref: OperationRef, reason: string): Promise<void>;
  /** For tests and diagnostics: how many tallies are held in memory. */
  size(): number;
}

/**
 * An operation is identified by its owner, kind and id - and nothing else.
 *
 * Metadata is deliberately outside the key: the tally arrives from the model
 * call, which knows the operation id but not the workspace the run belongs to,
 * while the settlement knows both. Keying on the workspace split one operation
 * into two entries, so the settle read an empty tally and charged a flat
 * estimate with no tokens at all.
 */
const keyOf = (ref: { ownerRef: string; kind: string; operationId: string }): string =>
  `${ref.ownerRef}\u0000${ref.kind}\u0000${ref.operationId}`;

const add = (current: number | null, next: number | null | undefined): number | null => {
  if (next === null || next === undefined) return current;
  return (current ?? 0) + next;
};

export function createOperationBilling(deps: {
  readonly messageCredits: Pick<MessageCreditService, 'reserve' | 'commit' | 'release'>;
}): OperationBilling {
  const ledgers = new Map<string, OperationLedger>();
  const settled = new Map<string, OperationSettlement>();
  const inFlight = new Map<string, Promise<OperationSettlement>>();

  const empty = (): OperationTally => ({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    toolCalls: null,
    durationMs: 0,
    calls: 0,
    modelId: null,
    providerId: null,
  });

  const tallies = new Map<string, OperationTally>();

  const tallyFor = (ref: OperationRef): OperationTally => {
    const key = keyOf(ref);
    const existing = tallies.get(key);
    if (existing !== undefined) return existing;
    const fresh = empty();
    tallies.set(key, fresh);
    return fresh;
  };

  const billing: OperationBilling = {
    async begin(ref) {
      const key = keyOf(ref);
      const existing = ledgers.get(key);
      if (existing !== undefined) return existing;

      const result = await deps.messageCredits.reserve({
        ownerRef: ref.ownerRef,
        ...(ref.workspaceId === undefined || ref.workspaceId === null
          ? {}
          : { workspaceId: ref.workspaceId }),
        ...(ref.projectId === undefined || ref.projectId === null
          ? {}
          : { projectId: ref.projectId }),
        ...(ref.conversationId === undefined || ref.conversationId === null
          ? {}
          : { conversationId: ref.conversationId }),
        ...(ref.taskId === undefined || ref.taskId === null ? {} : { taskId: ref.taskId }),
        ...(ref.parentChargeId === undefined || ref.parentChargeId === null
          ? {}
          : { parentChargeId: ref.parentChargeId }),
        kind: ref.kind,
        // The operation id, not the request id: a retry of the same coding run or
        // the same worker finds its first hold instead of holding twice.
        idempotencyKey: `op:${ref.kind}:${ref.operationId}`,
        // Every provider call in this deployment uses the caller's key, so the
        // operation is BYOK unless a caller says otherwise.
        byok: ref.byok ?? true,
      });

      const ledger: OperationLedger = {
        key,
        ref,
        chargeId: result.charge.id,
        exempt: result.charge.state === 'exempt',
        record(usage) {
          const tally = tallyFor(ref);
          tally.inputTokens = add(tally.inputTokens, usage.inputTokens ?? null);
          tally.outputTokens = add(tally.outputTokens, usage.outputTokens ?? null);
          tally.cachedInputTokens = add(tally.cachedInputTokens, usage.cachedInputTokens ?? null);
          tally.toolCalls = add(tally.toolCalls, usage.toolCalls ?? null);
          tally.durationMs += Math.max(0, usage.durationMs ?? 0);
          tally.calls += 1;
          if (usage.modelId !== undefined && usage.modelId !== null) tally.modelId = usage.modelId;
          if (usage.providerId !== undefined && usage.providerId !== null) {
            tally.providerId = usage.providerId;
          }
        },
        tally: () => ({ ...tallyFor(ref) }),
      };
      ledgers.set(key, ledger);
      return ledger;
    },

    record(ref, usage) {
      const key = keyOf(ref);
      const ledger = ledgers.get(key);
      if (ledger === undefined) {
        // Reported before anyone asked to be charged (a provider event that
        // arrived after the operation gave up). Keep the number for a later
        // settlement instead of dropping it on the floor.
        const tally = tallyFor(ref);
        tally.inputTokens = add(tally.inputTokens, usage.inputTokens ?? null);
        tally.outputTokens = add(tally.outputTokens, usage.outputTokens ?? null);
        tally.cachedInputTokens = add(tally.cachedInputTokens, usage.cachedInputTokens ?? null);
        tally.toolCalls = add(tally.toolCalls, usage.toolCalls ?? null);
        tally.durationMs += Math.max(0, usage.durationMs ?? 0);
        tally.calls += 1;
        if (usage.modelId !== undefined && usage.modelId !== null) tally.modelId = usage.modelId;
        if (usage.providerId !== undefined && usage.providerId !== null) {
          tally.providerId = usage.providerId;
        }
        return;
      }
      ledger.record(usage);
    },

    async settle(ref) {
      const key = keyOf(ref);
      const running = inFlight.get(key);
      if (running !== undefined) {
        const shared = await running;
        return { ...shared, settled: false, reason: 'already-settled' };
      }
      const already = settled.get(key);
      if (already !== undefined) return { ...already, settled: false, reason: 'already-settled' };

      const ledger = ledgers.get(key);
      if (ledger === undefined || ledger.chargeId === null) {
        return {
          settled: false,
          chargeId: null,
          credits: 0,
          calls: 0,
          reason: 'no-hold',
        };
      }

      const tally = tallyFor(ref);
      const attempt = (async (): Promise<OperationSettlement> => {
        const result = await deps.messageCredits.commit({
          ownerRef: ref.ownerRef,
          ...(ref.workspaceId === undefined || ref.workspaceId === null
            ? {}
            : { workspaceId: ref.workspaceId }),
          chargeId: ledger.chargeId as string,
          measurement: {
            inputTokens: tally.inputTokens,
            outputTokens: tally.outputTokens,
            cachedTokens: tally.cachedInputTokens,
            toolCalls: tally.toolCalls,
            durationMs: tally.calls === 0 ? null : tally.durationMs,
            ...(tally.modelId === null ? {} : { modelId: tally.modelId }),
            ...(tally.providerId === null ? {} : { providerId: tally.providerId }),
            source: tally.inputTokens === null ? 'unavailable' : 'provider',
          },
        });
        const outcome: OperationSettlement = {
          settled: true,
          chargeId: result.charge.id,
          credits: result.credits,
          calls: tally.calls,
          reason: null,
        };
        settled.set(key, outcome);
        ledgers.delete(key);
        tallies.delete(key);
        return outcome;
      })();
      inFlight.set(key, attempt);
      try {
        return await attempt;
      } catch (error) {
        const message = String((error as Error)?.message ?? 'settlement failed');
        settled.set(key, {
          settled: false,
          chargeId: ledger.chargeId,
          credits: 0,
          calls: tally.calls,
          reason: message,
        });
        throw error;
      } finally {
        inFlight.delete(key);
      }
    },

    async abandon(ref, reason) {
      const key = keyOf(ref);
      const ledger = ledgers.get(key);
      ledgers.delete(key);
      tallies.delete(key);
      if (ledger === undefined || ledger.chargeId === null) return;
      await deps.messageCredits.release({
        ownerRef: ref.ownerRef,
        ...(ref.workspaceId === undefined || ref.workspaceId === null
          ? {}
          : { workspaceId: ref.workspaceId }),
        chargeId: ledger.chargeId,
        reason,
      });
    },

    size: () => ledgers.size,
  };

  return billing;
}

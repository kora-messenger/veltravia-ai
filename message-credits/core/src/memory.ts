/**
 * In-memory charges, for tests and for a laptop with no database.
 *
 * Same guarantees as the Postgres store where it matters: one row per
 * idempotency key, and compare-and-set on the state.
 */

import type {
  ChargePage,
  LimitUsageGroup,
  LimitUsageOptions,
  MessageCreditStore,
  SpendingSettings,
  UsageDimension,
} from './store.js';
import type { ChargeFilter, MessageCharge, UsageGroup } from './types.js';

/**
 * The free-text half of a charge filter (Step 58). Matched here the same way the
 * Postgres store matches it, so a search returns the same rows on either store.
 */
const round = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

function matchesQuery(charge: MessageCharge, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [charge.id, charge.modelId, charge.providerId, charge.projectId, charge.kind].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  );
}

export class InMemoryMessageCreditStore implements MessageCreditStore {
  readonly kind = 'memory' as const;
  private readonly charges: MessageCharge[] = [];
  private readonly settings = new Map<string, SpendingSettings>();

  /**
   * Serialises one owner's check-then-hold (Step 59).
   *
   * A promise chain, which is all a single process needs: the second caller
   * waits for the first to finish writing its hold before it reads the usage.
   * Across processes Postgres holds the same lock as an advisory transaction.
   */
  private readonly ownerGuards = new Map<string, Promise<unknown>>();

  async withOwnerGuard<T>(ownerRef: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.ownerGuards.get(ownerRef) ?? Promise.resolve();
    // `then(fn, fn)` runs the work whether the previous caller resolved or threw:
    // one refusal must not strand the queue behind it.
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.ownerGuards.set(ownerRef, tail);
    void tail.then(() => {
      // Only the last queued caller clears the entry, so the map does not grow
      // by one dead key per owner forever.
      if (this.ownerGuards.get(ownerRef) === tail) this.ownerGuards.delete(ownerRef);
    });
    return run;
  }

  private key(ownerRef: string, workspaceId: string | null): string {
    return `${ownerRef}\u0000${workspaceId ?? ''}`;
  }

  async insertCharge(charge: MessageCharge): Promise<{ charge: MessageCharge; created: boolean }> {
    const existing = this.charges.find(
      (row) => row.ownerRef === charge.ownerRef && row.idempotencyKey === charge.idempotencyKey,
    );
    if (existing !== undefined) return { charge: { ...existing }, created: false };
    this.charges.push({ ...charge });
    return { charge: { ...charge }, created: true };
  }

  async findByKey(ownerRef: string, idempotencyKey: string): Promise<MessageCharge | null> {
    const found = this.charges.find(
      (row) => row.ownerRef === ownerRef && row.idempotencyKey === idempotencyKey,
    );
    return found === undefined ? null : { ...found };
  }

  async findById(ownerRef: string, chargeId: string): Promise<MessageCharge | null> {
    const found = this.charges.find((row) => row.ownerRef === ownerRef && row.id === chargeId);
    return found === undefined ? null : { ...found };
  }

  async saveCharge(charge: MessageCharge, expectedState: MessageCharge['state']): Promise<boolean> {
    const index = this.charges.findIndex(
      (row) => row.ownerRef === charge.ownerRef && row.id === charge.id,
    );
    if (index < 0) return false;
    if (this.charges[index]?.state !== expectedState) return false;
    this.charges[index] = { ...charge };
    return true;
  }

  async listCharges(ownerRef: string, filter: ChargeFilter): Promise<ChargePage> {
    const matches = this.charges
      .filter((row) => row.ownerRef === ownerRef)
      .filter((row) => (filter.workspaceId == null ? true : row.workspaceId === filter.workspaceId))
      .filter((row) =>
        filter.conversationId == null ? true : row.conversationId === filter.conversationId,
      )
      .filter((row) => (filter.projectId == null ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.runId == null ? true : row.runId === filter.runId))
      .filter((row) => (filter.kind === undefined ? true : row.kind === filter.kind))
      .filter((row) => (filter.state === undefined ? true : row.state === filter.state))
      .filter((row) => (filter.since === undefined ? true : row.createdAt >= filter.since))
      .filter((row) => (filter.until === undefined ? true : row.createdAt <= filter.until))
      .filter(
        (row) =>
          filter.beforeAt === undefined ||
          row.createdAt < filter.beforeAt ||
          (row.createdAt === filter.beforeAt &&
            (filter.beforeId === undefined || row.id < filter.beforeId)),
      )
      .filter((row) => (filter.modelId === undefined ? true : row.modelId === filter.modelId))
      .filter((row) =>
        filter.providerId === undefined ? true : row.providerId === filter.providerId,
      )
      .filter((row) => (filter.query === undefined ? true : matchesQuery(row, filter.query)))
      // Ties broken by id so a page boundary is stable: a cursor that
      // names one row must not be overtaken by an equally-timed sibling.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const offset = filter.offset ?? 0;
    return {
      charges: matches.slice(offset, offset + filter.limit).map((row) => ({ ...row })),
      total: matches.length,
    };
  }

  async aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options: { readonly since?: string; readonly workspaceId?: string | null } = {},
  ): Promise<readonly UsageGroup[]> {
    const groups = new Map<string, UsageGroup>();
    for (const row of this.charges) {
      if (row.ownerRef !== ownerRef) continue;
      if (options.since !== undefined && row.createdAt < options.since) continue;
      if (options.workspaceId != null && row.workspaceId !== options.workspaceId) continue;
      if (row.state === 'reserved' || row.state === 'released') continue;
      const key =
        dimension === 'model'
          ? (row.modelId ?? 'unreported')
          : dimension === 'project'
            ? (row.projectId ?? 'no-project')
            : dimension === 'conversation'
              ? (row.conversationId ?? 'no-conversation')
              : row.kind;
      const current = groups.get(key) ?? {
        key,
        charges: 0,
        credits: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      groups.set(key, {
        key,
        charges: current.charges + 1,
        credits: Math.round((current.credits + row.credits) * 10_000) / 10_000,
        inputTokens: current.inputTokens + (row.inputTokens ?? 0),
        outputTokens: current.outputTokens + (row.outputTokens ?? 0),
      });
    }
    return [...groups.values()].sort((a, b) => b.credits - a.credits);
  }

  async limitUsage(
    ownerRef: string,
    options: LimitUsageOptions,
  ): Promise<readonly LimitUsageGroup[]> {
    const since = Date.parse(options.since);
    const until = Date.parse(options.until);
    const groups = new Map<string, LimitUsageGroup>();
    for (const row of this.charges) {
      if (row.ownerRef !== ownerRef) continue;
      const at = Date.parse(row.createdAt);
      if (!Number.isFinite(at) || at < since || at >= until) continue;
      if (options.workspaceId != null && row.workspaceId !== options.workspaceId) continue;
      if (options.projectId != null && row.projectId !== options.projectId) continue;
      if (row.state === 'released') continue;
      const current = groups.get(row.kind) ?? {
        key: row.kind,
        committed: 0,
        reserved: 0,
        refunded: 0,
        charges: 0,
      };
      groups.set(row.kind, {
        key: row.kind,
        charges: current.charges + 1,
        committed: round(current.committed + (row.state === 'committed' ? row.credits : 0)),
        reserved: round(current.reserved + (row.state === 'reserved' ? row.estimatedCredits : 0)),
        refunded: round(current.refunded + (row.state === 'refunded' ? row.credits : 0)),
      });
    }
    return [...groups.values()];
  }

  async heldCredits(ownerRef: string): Promise<number> {
    return round(
      this.charges
        .filter((row) => row.ownerRef === ownerRef && row.state === 'reserved')
        .reduce((total, row) => total + row.estimatedCredits, 0),
    );
  }

  async readSettings(
    ownerRef: string,
    workspaceId: string | null,
  ): Promise<SpendingSettings | null> {
    const found = this.settings.get(this.key(ownerRef, workspaceId));
    return found === undefined ? null : { ...found };
  }

  async saveSettings(settings: SpendingSettings): Promise<SpendingSettings> {
    this.settings.set(this.key(settings.ownerRef, settings.workspaceId), { ...settings });
    return { ...settings };
  }

  async listOpen(ownerRef: string, limit: number): Promise<readonly MessageCharge[]> {
    return this.charges
      .filter((row) => row.ownerRef === ownerRef && row.state === 'reserved')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}

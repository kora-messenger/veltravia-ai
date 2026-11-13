/**
 * In-memory integration charges, for tests and for a laptop with no database.
 *
 * Same guarantees as the Postgres store where it matters: one row per
 * idempotency key, and compare-and-set on the state.
 */

import type {
  ChargePage,
  IntegrationCreditStore,
  IntegrationSpendingSettings,
  LimitUsageGroup,
  LimitUsageOptions,
  UsageDimension,
} from './store.js';
import type { ChargeFilter, IntegrationCharge, MeasurementUnit, UsageGroup } from './types.js';

const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

const totalUnits = (units: Readonly<Partial<Record<MeasurementUnit, number>>>): number =>
  Object.values(units).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);

/** The free-text half of a charge filter (Step 58); mirrors the Postgres store. */
function matchesQuery(charge: IntegrationCharge, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [
    charge.id,
    charge.operationId,
    charge.integrationId,
    charge.connectorId,
    charge.projectId,
    charge.kind,
  ].some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

export class InMemoryIntegrationCreditStore implements IntegrationCreditStore {
  readonly kind = 'memory' as const;
  private readonly charges: IntegrationCharge[] = [];
  private readonly settings = new Map<string, IntegrationSpendingSettings>();

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

  async insertCharge(
    charge: IntegrationCharge,
  ): Promise<{ charge: IntegrationCharge; created: boolean }> {
    const existing = this.charges.find(
      (row) => row.ownerRef === charge.ownerRef && row.idempotencyKey === charge.idempotencyKey,
    );
    if (existing !== undefined) return { charge: { ...existing }, created: false };
    this.charges.push({ ...charge });
    return { charge: { ...charge }, created: true };
  }

  async findByKey(ownerRef: string, idempotencyKey: string): Promise<IntegrationCharge | null> {
    const found = this.charges.find(
      (row) => row.ownerRef === ownerRef && row.idempotencyKey === idempotencyKey,
    );
    return found === undefined ? null : { ...found };
  }

  async findById(ownerRef: string, chargeId: string): Promise<IntegrationCharge | null> {
    const found = this.charges.find((row) => row.ownerRef === ownerRef && row.id === chargeId);
    return found === undefined ? null : { ...found };
  }

  async saveCharge(
    charge: IntegrationCharge,
    expectedState: IntegrationCharge['state'],
  ): Promise<boolean> {
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
      .filter((row) => (filter.projectId == null ? true : row.projectId === filter.projectId))
      .filter((row) =>
        filter.integrationId == null ? true : row.integrationId === filter.integrationId,
      )
      .filter((row) => (filter.connectorId == null ? true : row.connectorId === filter.connectorId))
      .filter((row) => (filter.operationId == null ? true : row.operationId === filter.operationId))
      .filter((row) => (filter.executionId == null ? true : row.executionId === filter.executionId))
      .filter((row) => (filter.kind === undefined ? true : row.kind === filter.kind))
      .filter((row) => (filter.state === undefined ? true : row.state === filter.state))
      .filter((row) =>
        filter.billingClass === undefined ? true : row.billingClass === filter.billingClass,
      )
      .filter((row) => (filter.since === undefined ? true : row.createdAt >= filter.since))
      .filter((row) => (filter.until === undefined ? true : row.createdAt <= filter.until))
      .filter(
        (row) =>
          filter.beforeAt === undefined ||
          row.createdAt < filter.beforeAt ||
          (row.createdAt === filter.beforeAt &&
            (filter.beforeId === undefined || row.id < filter.beforeId)),
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
        committed: round4(current.committed + (row.state === 'committed' ? row.credits : 0)),
        reserved: round4(current.reserved + (row.state === 'reserved' ? row.estimatedCredits : 0)),
        refunded: round4(current.refunded + (row.state === 'refunded' ? row.credits : 0)),
      });
    }
    return [...groups.values()];
  }

  async heldCredits(ownerRef: string): Promise<number> {
    return round4(
      this.charges
        .filter((row) => row.ownerRef === ownerRef && row.state === 'reserved')
        .reduce((total, row) => total + row.estimatedCredits, 0),
    );
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
        dimension === 'integration'
          ? (row.integrationId ?? 'unassigned')
          : dimension === 'connector'
            ? (row.connectorId ?? 'no-connector')
            : dimension === 'operation'
              ? (row.operationId ?? 'no-operation')
              : dimension === 'project'
                ? (row.projectId ?? 'no-project')
                : row.billingClass;
      const current = groups.get(key) ?? { key, charges: 0, credits: 0, requests: 0, units: 0 };
      groups.set(key, {
        key,
        charges: current.charges + 1,
        credits: Math.round((current.credits + row.credits) * 10_000) / 10_000,
        requests: current.requests + (row.requests ?? 0),
        units: current.units + totalUnits(row.units),
      });
    }
    return [...groups.values()].sort((a, b) => b.credits - a.credits);
  }

  async readSettings(
    ownerRef: string,
    workspaceId: string | null,
  ): Promise<IntegrationSpendingSettings | null> {
    const found = this.settings.get(this.key(ownerRef, workspaceId));
    return found === undefined ? null : { ...found };
  }

  async saveSettings(settings: IntegrationSpendingSettings): Promise<IntegrationSpendingSettings> {
    this.settings.set(this.key(settings.ownerRef, settings.workspaceId), { ...settings });
    return { ...settings };
  }

  async listOpen(ownerRef: string, limit: number): Promise<readonly IntegrationCharge[]> {
    return this.charges
      .filter((row) => row.ownerRef === ownerRef && row.state === 'reserved')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listOpenOwners(limit: number): Promise<readonly string[]> {
    const owners: string[] = [];
    const open = this.charges
      .filter((row) => row.state === 'reserved')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const row of open) {
      if (owners.includes(row.ownerRef)) continue;
      owners.push(row.ownerRef);
      if (owners.length >= limit) break;
    }
    return owners;
  }
}

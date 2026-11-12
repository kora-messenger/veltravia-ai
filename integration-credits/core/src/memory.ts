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
  UsageDimension,
} from './store.js';
import type { ChargeFilter, IntegrationCharge, MeasurementUnit, UsageGroup } from './types.js';

const totalUnits = (units: Readonly<Partial<Record<MeasurementUnit, number>>>): number =>
  Object.values(units).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);

export class InMemoryIntegrationCreditStore implements IntegrationCreditStore {
  readonly kind = 'memory' as const;
  private readonly charges: IntegrationCharge[] = [];
  private readonly settings = new Map<string, IntegrationSpendingSettings>();

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
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
}

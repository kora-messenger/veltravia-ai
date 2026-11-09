/**
 * In-memory charges, for tests and for a laptop with no database.
 *
 * Same guarantees as the Postgres store where it matters: one row per
 * idempotency key, and compare-and-set on the state.
 */

import type { ChargePage, MessageCreditStore, SpendingSettings, UsageDimension } from './store.js';
import type { ChargeFilter, MessageCharge, UsageGroup } from './types.js';

export class InMemoryMessageCreditStore implements MessageCreditStore {
  readonly kind = 'memory' as const;
  private readonly charges: MessageCharge[] = [];
  private readonly settings = new Map<string, SpendingSettings>();

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

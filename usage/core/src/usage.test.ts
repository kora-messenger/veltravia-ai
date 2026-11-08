import { describe, expect, it } from 'vitest';

import {
  InMemoryUsageStore,
  PLAN_CATALOG,
  UsageLedger,
  UsageProblem,
  applyAdjustments,
  byCostBearer,
  byProject,
  capabilityFor,
  costTotals,
  dailySeries,
  evaluateQuota,
  monthWindow,
  parsePriceTable,
  providerBearer,
  providerCost,
  quotaForCategory,
  resolveLimit,
  selectRecords,
  totals,
  unitFor,
  type UsageRecord,
} from './index.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');

function ledgerAt(store = new InMemoryUsageStore(20000, () => NOW), now = NOW) {
  let seq = 0;
  return new UsageLedger({
    now: () => now,
    store,
    environment: 'development',
    newId: () => `usg_${++seq}`,
  });
}

const base = {
  ownerRef: 'owner-1',
  category: 'backend_execution' as const,
  operation: 'worker.run',
  quantity: 1500,
};

describe('usage ledger', () => {
  it('records a measured quantity once per operation key', async () => {
    const ledger = ledgerAt();

    const first = await ledger.record({ ...base, operationKey: 'wkr_1:run' });
    const second = await ledger.record({ ...base, operationKey: 'wkr_1:run' });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    const rows = await ledger.store.listRecords({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(1500);
    expect(rows[0]?.unit).toBe('milliseconds');
  });

  it('marks who pays, and does not let BYOK tokens touch a Veltravia allowance', async () => {
    const ledger = ledgerAt();

    await ledger.record({
      ownerRef: 'owner-1',
      category: 'ai_provider',
      operation: 'ai.request',
      quantity: 900,
      operationKey: 'run_1:call_1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-4o-mini',
      costBearer: providerBearer(true),
      costUsd: 0.0004,
      costSource: 'provider_reported',
      source: 'provider_reported',
    });
    await ledger.record({
      ownerRef: 'owner-1',
      category: 'ai_provider',
      operation: 'ai.request',
      quantity: 500,
      operationKey: 'run_2:call_1',
      providerId: 'groq',
      modelId: 'openai/gpt-oss-20b',
      costBearer: providerBearer(false),
      costUsd: 0.0001,
      costSource: 'price_table',
      source: 'provider_reported',
    });

    const rows = await ledger.store.listRecords({ limit: 10 });
    const allowance = selectRecords(rows, { allowanceOnly: true });
    // Only the Veltravia-managed request is deducted; the BYOK one is recorded
    // for transparency and stops there.
    expect(allowance).toHaveLength(1);
    expect(allowance[0]?.costBearer).toBe('veltravia');

    const cost = costTotals(rows);
    expect(cost.providerUsd).toBeCloseTo(0.0001, 6);
    expect(cost.byokProviderUsd).toBeCloseTo(0.0004, 6);
    expect(cost.infrastructureUsd).toBe(0);
  });

  it('keeps a refusal identifiable instead of a bare failure', async () => {
    const ledger = ledgerAt();

    await expect(
      ledger.record({ ...base, quantity: Number.NaN, operationKey: 'bad' }),
    ).rejects.toBeInstanceOf(UsageProblem);

    await expect(
      ledger.record({ ...base, quantity: 10, operationKey: '  ' }),
    ).rejects.toMatchObject({ code: 'USAGE_INVALID' });
  });

  it('refuses a hold beyond a hard concurrency limit and keeps the arithmetic', async () => {
    const ledger = ledgerAt();
    const limits = { ...PLAN_CATALOG.development.limits, concurrentJobs: 1 };

    const first = await ledger.reserve({
      ownerRef: 'owner-1',
      projectId: 'prj_1',
      category: 'background_jobs',
      quantity: 1,
      operationKey: 'job:1',
      plan: limits,
      concurrency: true,
    });
    expect(first.status).toBe('held');

    const refusal = await ledger
      .reserve({
        ownerRef: 'owner-1',
        projectId: 'prj_1',
        category: 'background_jobs',
        quantity: 1,
        operationKey: 'job:2',
        plan: limits,
        concurrency: true,
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(UsageProblem);
    const problem = refusal as UsageProblem;
    expect(problem.decision?.allowed).toBe(false);
    expect(problem.decision?.limit).toBe(1);
    expect(problem.decision?.evidence.join(' ')).toContain('reservations:background_jobs');
  });

  it('lets a released hold free the slot again, and counts a committed one as spent', async () => {
    const ledger = ledgerAt();
    const limits = { ...PLAN_CATALOG.development.limits, concurrentJobs: 1 };

    await ledger.reserve({
      ownerRef: 'owner-1',
      category: 'background_jobs',
      quantity: 1,
      operationKey: 'job:1',
      plan: limits,
      concurrency: true,
    });
    expect(await ledger.liveHolds('background_jobs')).toBe(1);

    await ledger.release('job:1', 'the worker never started');
    expect(await ledger.liveHolds('background_jobs')).toBe(0);

    const again = await ledger.reserve({
      ownerRef: 'owner-1',
      category: 'background_jobs',
      quantity: 1,
      operationKey: 'job:2',
      plan: limits,
      concurrency: true,
    });
    expect(again.status).toBe('held');
    await ledger.commit('job:2');
    // A committed hold is no longer live capacity, so the next one fits.
    expect(await ledger.liveHolds('background_jobs')).toBe(0);
  });

  it('does not hand the same slot to two concurrent claims', async () => {
    const ledger = ledgerAt();
    const limits = { ...PLAN_CATALOG.development.limits, concurrentJobs: 1 };

    const results = await Promise.allSettled([
      ledger.reserve({
        ownerRef: 'owner-1',
        category: 'background_jobs',
        quantity: 1,
        operationKey: 'job:a',
        plan: limits,
        concurrency: true,
      }),
      ledger.reserve({
        ownerRef: 'owner-1',
        category: 'background_jobs',
        quantity: 1,
        operationKey: 'job:b',
        plan: limits,
        concurrency: true,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('applies an audited adjustment without rewriting the record it corrects', async () => {
    const ledger = ledgerAt();
    const { record } = await ledger.record({
      ...base,
      quantity: 5000,
      operationKey: 'wkr_9:run',
    });

    const { adjustment, duplicate } = await ledger.adjust({
      ownerRef: 'owner-1',
      category: 'backend_execution',
      quantity: -4000,
      reason: 'Worker clock over-counted while the database was restarting.',
      actor: 'operator:ijezie',
      targetRecordId: record.id,
      adjustmentKey: 'adj_1',
    });
    expect(duplicate).toBe(false);
    expect(adjustment.targetRecordId).toBe(record.id);

    const rows = await ledger.store.listRecords({ limit: 10 });
    expect(rows[0]?.quantity).toBe(5000);

    const corrected = applyAdjustments(
      totals(rows),
      await ledger.store.listAdjustments({ limit: 10 }),
    );
    expect(corrected.backend_execution).toBe(1000);

    const replay = await ledger.adjust({
      ownerRef: 'owner-1',
      category: 'backend_execution',
      quantity: -4000,
      reason: 'Worker clock over-counted while the database was restarting.',
      actor: 'operator:ijezie',
      adjustmentKey: 'adj_1',
    });
    expect(replay.duplicate).toBe(true);
  });
});

describe('aggregation', () => {
  const ledger = ledgerAt();
  const at = (iso: string) => iso;

  async function seed() {
    await ledger.record({
      ...base,
      operationKey: 'a1',
      projectId: 'prj_a',
      quantity: 1000,
      occurredAt: at('2026-11-01T09:00:00.000Z'),
    });
    await ledger.record({
      ...base,
      operationKey: 'a2',
      projectId: 'prj_a',
      quantity: 2000,
      occurredAt: at('2026-11-01T10:00:00.000Z'),
    });
    await ledger.record({
      ownerRef: 'owner-1',
      category: 'file_storage',
      operation: 'file.upload',
      resource: 'notes.md',
      quantity: 4096,
      operationKey: 'f1',
      projectId: 'prj_b',
      occurredAt: at('2026-11-02T09:00:00.000Z'),
    });
  }

  it('totals per category inside the calendar month and leaves other months out', async () => {
    await seed();
    const rows = await ledger.store.listRecords({ limit: 100 });
    const window = monthWindow(NOW);

    const month = totals(rows, { window });
    expect(month.backend_execution).toBe(3000);
    expect(month.file_storage).toBe(4096);

    const october = totals(rows, { window: monthWindow('2026-10-15T00:00:00.000Z') });
    expect(october.backend_execution).toBe(0);
  });

  it('separates projects and produces a daily series with the gaps included', async () => {
    const rows = await ledger.store.listRecords({ limit: 100 });

    const projects = byProject(rows);
    expect(projects.map((entry) => entry.key)).toEqual(['prj_a', 'prj_b']);

    const series = dailySeries(rows, monthWindow(NOW));
    expect(series).toHaveLength(30);
    expect(series[0]?.day).toBe('2026-11-01');
    expect(series[0]?.totals.backend_execution).toBe(3000);
    expect(series[1]?.totals.file_storage).toBe(4096);
    expect(series[2]?.totals.backend_execution).toBe(0);
  });

  it('reports bearer split so a BYOK bill is never read as infrastructure', async () => {
    const rows = await ledger.store.listRecords({ limit: 100 });
    expect(byCostBearer(rows)[0]?.key).toBe('veltravia');
  });
});

describe('quotas', () => {
  it('resolves the most specific scope and says which one it used', () => {
    const project = resolveLimit('concurrentJobs', {
      plan: 'development',
      owner: { concurrentJobs: 5 },
      project: { concurrentJobs: 2 },
    });
    expect(project.value).toBe(2);
    expect(project.scope).toBe('project');

    const owner = resolveLimit('concurrentJobs', {
      plan: 'development',
      owner: { concurrentJobs: 5 },
    });
    expect(owner.scope).toBe('owner');
    expect(owner.value).toBe(5);

    const plan = resolveLimit('concurrentJobs', { plan: 'paid' });
    expect(plan.scope).toBe('plan');
    expect(plan.value).toBe(PLAN_CATALOG.paid.limits.concurrentJobs);
  });

  it('treats a null override as unlimited, not as unset', () => {
    const resolved = resolveLimit('fileStorageBytes', {
      plan: 'development',
      owner: { fileStorageBytes: null },
    });
    expect(resolved.value).toBeNull();
    expect(resolved.scope).toBe('owner');
  });

  it('names the limit, the usage and the arithmetic in a refusal', () => {
    const decision = evaluateQuota({
      category: 'file_storage',
      requested: 10 * 1024 * 1024,
      limit: resolveLimit('fileStorageBytes', {
        plan: { ...PLAN_CATALOG.development.limits, fileStorageBytes: 5 * 1024 * 1024 },
      }),
      consumed: { fileStorageBytes: 1 * 1024 * 1024 },
      evidence: ['files:owned=3', 'bytes:1048576'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('STORAGE_LIMIT_REACHED');
    expect(decision.enforcement).toBe('hard');
    expect(decision.message).toContain('5.0 MB');
    expect(decision.message).toContain('refused before it started');
    expect(decision.evidence).toContain('bytes:1048576');
  });

  it('allows work inside the limit and reports the remainder', () => {
    const decision = evaluateQuota({
      category: 'background_jobs',
      requested: 3,
      limit: resolveLimit('backgroundJobs', {
        plan: { ...PLAN_CATALOG.development.limits, backgroundJobs: 10 },
      }),
      consumed: { backgroundJobs: 4 },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(3);
  });

  it('does not present an unobservable category as enforced', () => {
    const decision = evaluateQuota({
      category: 'hosting',
      requested: 1000,
      limit: {
        key: 'backendExecutionMs',
        value: 1,
        scope: 'plan',
        source: 'plan:development',
        enforcement: 'best_effort',
      },
      consumed: {},
    });
    expect(decision.allowed).toBe(true);
    expect(decision.message).toContain('not enforced');
    expect(decision.evidence).toContain('measurement:hosting=unavailable');
  });

  it('publishes a measurement status for every category, with a unit', () => {
    for (const category of [
      'database_storage',
      'backend_execution',
      'file_storage',
      'bandwidth',
      'hosting',
      'background_jobs',
      'realtime',
      'ai_provider',
    ] as const) {
      const capability = capabilityFor(category);
      expect(capability.status).not.toBeUndefined();
      expect(unitFor(category)).not.toBeUndefined();
      if (capability.status === 'unavailable') {
        expect(capability.note.length).toBeGreaterThan(20);
      }
      if (quotaForCategory(category) !== null) {
        expect(capability.unit).toBe(unitFor(category));
      }
    }
  });
});

describe('provider cost attribution', () => {
  it('uses a reported cost before any price table', () => {
    const cost = providerCost({
      providerId: 'openrouter',
      modelId: 'openai/gpt-4o-mini',
      inputTokens: 1000,
      outputTokens: 500,
      reportedCostUsd: 0.002,
      priceTable: parsePriceTable(
        JSON.stringify([
          {
            providerId: 'openrouter',
            modelId: 'openai/gpt-4o-mini',
            inputPerMillion: 1,
            outputPerMillion: 2,
          },
        ]),
      ),
    });
    expect(cost.costSource).toBe('provider_reported');
    expect(cost.costUsd).toBe(0.002);
  });

  it('computes from a configured price, and says so', () => {
    const table = parsePriceTable(
      JSON.stringify([
        {
          providerId: 'groq',
          modelId: 'openai/gpt-oss-20b',
          inputPerMillion: 0.1,
          outputPerMillion: 0.5,
        },
      ]),
    );
    const cost = providerCost({
      providerId: 'groq',
      modelId: 'openai/gpt-oss-20b',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      priceTable: table,
    });
    expect(cost.costSource).toBe('price_table');
    expect(cost.costUsd).toBeCloseTo(0.6, 6);
  });

  it('returns unknown rather than zero when nothing supports a price', () => {
    const noTable = providerCost({
      providerId: 'gemini',
      modelId: 'gemini-2.0-flash',
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(noTable.costUsd).toBeNull();
    expect(noTable.costSource).toBe('unknown');

    const noTokens = providerCost({
      providerId: 'gemini',
      modelId: 'gemini-2.0-flash',
      inputTokens: null,
      outputTokens: null,
      priceTable: parsePriceTable(
        JSON.stringify([
          {
            providerId: 'gemini',
            modelId: 'gemini-2.0-flash',
            inputPerMillion: 1,
            outputPerMillion: 1,
          },
        ]),
      ),
    });
    expect(noTokens.costUsd).toBeNull();
  });

  it('drops a malformed price row instead of defaulting it', () => {
    const table = parsePriceTable(
      JSON.stringify([
        { providerId: 'x', modelId: 'y', inputPerMillion: 'free', outputPerMillion: 1 },
        { providerId: 'x', modelId: 'z', inputPerMillion: -1, outputPerMillion: 1 },
        { providerId: 'ok', modelId: 'model', inputPerMillion: 1, outputPerMillion: 1 },
      ]),
    );
    expect(table).toHaveLength(1);
    expect(table[0]?.providerId).toBe('ok');
  });
});

describe('record shape', () => {
  it('keeps the measurement source and the allowance on the record', async () => {
    const ledger = ledgerAt();
    const { record } = await ledger.record({
      ownerRef: 'owner-1',
      projectId: 'prj_1',
      category: 'database_storage',
      operation: 'storage.snapshot',
      quantity: 2048,
      operationKey: 'db:prj_1:2026-11-08',
      allowance: 'development',
      detail: { tables: 6 },
    });
    const typed: UsageRecord = record;
    expect(typed.source).toBe('derived');
    expect(typed.environment).toBe('development');
    expect(typed.allowance).toBe('development');
    expect(typed.detail).toEqual({ tables: 6 });
  });
});

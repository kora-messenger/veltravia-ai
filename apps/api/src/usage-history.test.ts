/**
 * Usage history and cost dashboard (Step 58).
 *
 * The claims worth proving are narrow and specific:
 *
 *  - the balance on the dashboard is the wallet's, not a number this file added up;
 *  - a reservation, a deduction, a released hold and a refund read differently and
 *    are never summed into one figure;
 *  - filters (date, category, project, model, status, search) really narrow the
 *    rows, and paging with a cursor neither repeats nor skips one;
 *  - a total says when it is a partial sum instead of looking complete;
 *  - the CSV carries the same rows as the screen, and another owner sees nothing.
 *
 * Everything runs on the in-memory stores, so the numbers are arithmetic rather
 * than a database round trip. The Postgres block at the end proves the date and
 * search filters live in the SQL, because a filter that only works in memory is a
 * filter that would hide rows on a real deployment.
 */

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createPersistence } from './persistence.js';
import { createIntegrationCreditService } from './integration-credit-service.js';
import { createMessageCreditService } from './message-credit-service.js';
import { createUsageHistoryService, type UsageHistoryService } from './usage-history.js';
import { createUsageService } from './usage-service.js';
import { createWalletService, type WalletService } from './wallet-service.js';
import { registerUsageHistoryRoutes } from './routes/usage-history.js';

const OWNER = 'usage-history-owner';
const OTHER = 'somebody-else';
const env = {} as NodeJS.ProcessEnv;

interface Harness {
  readonly wallet: WalletService;
  readonly history: UsageHistoryService;
  readonly messageCredits: ReturnType<typeof createMessageCreditService>;
  readonly integrationCredits: ReturnType<typeof createIntegrationCreditService>;
  readonly usage: ReturnType<typeof createUsageService>;
}

function harness(options: { scanCap?: number; exportCap?: number } = {}): Harness {
  const wallet = createWalletService({ env });
  const usage = createUsageService({ env });
  const messageCredits = createMessageCreditService({
    env,
    wallet,
    planOf: async () => 'paid',
  });
  const integrationCredits = createIntegrationCreditService({
    env,
    wallet,
    planOf: async () => 'paid',
  });
  const history = createUsageHistoryService({
    wallet,
    usage,
    messageCredits,
    integrationCredits,
    ...(options.scanCap === undefined ? {} : { scanCap: options.scanCap }),
    ...(options.exportCap === undefined ? {} : { exportCap: options.exportCap }),
  });
  return { wallet, usage, messageCredits, integrationCredits, history };
}

async function fund(wallet: WalletService, amount = 500, ownerRef = OWNER): Promise<void> {
  await wallet.credit({
    ownerRef,
    amount,
    kind: 'grant',
    reason: 'test funding',
    actor: 'test',
    idempotencyKey: `fund-${ownerRef}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

/** One settled chat turn: hold, then settle from measured tokens. */
async function chargeChat(
  parts: Harness,
  input: {
    key: string;
    projectId?: string | null;
    modelId?: string;
    withTokens?: boolean;
    ownerRef?: string;
  },
): Promise<string> {
  const ownerRef = input.ownerRef ?? OWNER;
  const reserved = await parts.messageCredits.reserve({
    ownerRef,
    kind: 'chat.message',
    idempotencyKey: input.key,
    modelId: input.modelId ?? 'openai/gpt-4o-mini',
    providerId: 'openai',
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  await parts.messageCredits.commit({
    ownerRef,
    chargeId: reserved.charge.id,
    measurement:
      input.withTokens === false
        ? { source: 'unavailable' }
        : { inputTokens: 1000, outputTokens: 400, cachedTokens: 200, source: 'provider' },
  });
  return reserved.charge.id;
}

describe('usage history (Step 58)', () => {
  it('shows the wallet balance the ledger holds, not a sum of charges', async () => {
    const parts = harness();
    await fund(parts.wallet, 100);
    await chargeChat(parts, { key: 'a' });

    const overview = await parts.history.overview({ ownerRef: OWNER });
    const wallet = await parts.wallet.ensure({ ownerRef: OWNER });

    expect(overview.wallet.available).toBe(wallet.available);
    expect(overview.wallet.reserved).toBe(wallet.reserved);
    expect(overview.wallet.spent).toBe(wallet.spent);
    expect(overview.wallet.currency).toBe('VELTRAVIA_CREDITS');
    // The charge is real, so something was spent and something remains.
    expect(overview.wallet.spent).toBeGreaterThan(0);
  }, 20_000);

  it('aggregates the range by category and keeps the totals consistent', async () => {
    const parts = harness();
    await fund(parts.wallet, 400);
    await chargeChat(parts, { key: 'b1', projectId: 'p-1' });
    await chargeChat(parts, { key: 'b2', projectId: 'p-1' });
    await parts.messageCredits.reserve({
      ownerRef: OWNER,
      kind: 'coding.run',
      idempotencyKey: 'b3',
      modelId: 'openai/gpt-4o-mini',
    });

    const overview = await parts.history.overview({ ownerRef: OWNER });
    const chat = overview.selected.byCategory.find((group) => group.key === 'ai_messages');
    const coding = overview.selected.byCategory.find((group) => group.key === 'coding');

    expect(chat?.events).toBe(2);
    expect(chat?.credits).toBeGreaterThan(0);
    // A coding reservation is not a deduction, so it contributes events but no credit.
    expect(coding?.events).toBe(1);
    expect(coding?.credits).toBe(0);
    expect(overview.selected.completeness.complete).toBe(true);
    expect(overview.selected.credits).toBe(chat?.credits);
  }, 20_000);

  it('separates a reservation, a deduction, a release and a refund', async () => {
    const parts = harness();
    await fund(parts.wallet, 200);

    // No token counts: the flat price is the whole charge, so the settlement
    // posts the hold itself and a refund has a spent entry to give back.
    const settled = await chargeChat(parts, { key: 'c1', withTokens: false });
    const held = await parts.messageCredits.reserve({
      ownerRef: OWNER,
      kind: 'chat.message',
      idempotencyKey: 'c2',
      modelId: 'openai/gpt-4o-mini',
    });
    const toRelease = await parts.messageCredits.reserve({
      ownerRef: OWNER,
      kind: 'chat.message',
      idempotencyKey: 'c3',
      modelId: 'openai/gpt-4o-mini',
    });
    await parts.messageCredits.release({
      ownerRef: OWNER,
      chargeId: toRelease.charge.id,
      reason: 'the interaction failed',
    });
    await parts.messageCredits.refund({
      ownerRef: OWNER,
      chargeId: settled,
      reason: 'charged twice',
      actor: 'operator',
    });

    const page = await parts.history.history({ ownerRef: OWNER }, { limit: 25 });
    const byId = new Map(page.events.map((event) => [event.id, event]));

    expect(byId.get(`charge:${settled}`)?.movement).toBe('refund');
    expect(byId.get(`charge:${held.charge.id}`)?.movement).toBe('reservation');
    expect(byId.get(`charge:${held.charge.id}`)?.credits).toBe(0);
    expect(byId.get(`charge:${held.charge.id}`)?.status).toBe('reserved');
    expect(byId.get(`charge:${toRelease.charge.id}`)?.movement).toBe('release');
    expect(byId.get(`charge:${toRelease.charge.id}`)?.credits).toBe(0);

    const reservedCredits = page.events
      .filter((event) => event.movement === 'reservation')
      .reduce((sum, event) => sum + event.credits, 0);
    expect(reservedCredits).toBe(0);
  }, 20_000);

  it('filters by date, project, model and status without reading the browser side', async () => {
    const parts = harness();
    await fund(parts.wallet, 200);
    await chargeChat(parts, { key: 'd1', projectId: 'alpha', modelId: 'openai/gpt-4o-mini' });
    await chargeChat(parts, { key: 'd2', projectId: 'beta', modelId: 'anthropic/claude-3' });
    await parts.messageCredits.reserve({
      ownerRef: OWNER,
      kind: 'chat.message',
      idempotencyKey: 'd3',
      projectId: 'alpha',
      modelId: 'openai/gpt-4o-mini',
    });

    const byProject = await parts.history.history(
      { ownerRef: OWNER },
      { projectId: 'alpha', limit: 25 },
    );
    expect(byProject.events.length).toBeGreaterThan(0);
    expect(byProject.events.every((event) => event.projectId === 'alpha')).toBe(true);

    const byModel = await parts.history.history(
      { ownerRef: OWNER },
      { modelId: 'anthropic/claude-3', limit: 25 },
    );
    expect(byModel.events.every((event) => event.modelId === 'anthropic/claude-3')).toBe(true);
    expect(byModel.events.length).toBe(1);

    const reserved = await parts.history.history(
      { ownerRef: OWNER },
      { status: ['reserved'], limit: 25 },
    );
    expect(reserved.events.every((event) => event.status === 'reserved')).toBe(true);
    expect(reserved.events.length).toBe(1);

    // A range before anything happened must be empty rather than "everything".
    const past = await parts.history.history(
      { ownerRef: OWNER },
      { from: '2020-01-01', to: '2020-01-31', limit: 25 },
    );
    expect(past.events).toEqual([]);
    expect(past.total).toBe(0);
  }, 20_000);

  it('pages with a cursor without repeating or skipping a row', async () => {
    const parts = harness();
    await fund(parts.wallet, 400);
    for (let index = 0; index < 7; index += 1) {
      await chargeChat(parts, { key: `e${index}` });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await parts.history.history(
        { ownerRef: OWNER },
        { limit: 3, ...(cursor === undefined ? {} : { cursor }) },
      );
      seen.push(...result.events.map((event) => event.id));
      if (!result.hasMore || result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  }, 20_000);

  it('says a total is partial when the scan cap is reached', async () => {
    const parts = harness({ scanCap: 3 });
    await fund(parts.wallet, 400);
    for (let index = 0; index < 5; index += 1) {
      await chargeChat(parts, { key: `f${index}` });
    }

    const overview = await parts.history.overview({ ownerRef: OWNER });
    expect(overview.selected.completeness.complete).toBe(false);
    expect(overview.selected.completeness.note).toContain('partial sum');
    expect(overview.selected.completeness.scanned).toBeLessThanOrEqual(3);
  }, 20_000);

  it('reports a charge whose measurement is missing without inventing tokens', async () => {
    const parts = harness();
    await fund(parts.wallet, 100);
    await chargeChat(parts, { key: 'g1', withTokens: false });

    const page = await parts.history.history({ ownerRef: OWNER }, { limit: 10 });
    const event = page.events[0];
    expect(event).toBeDefined();
    // The flat price still applies, so credit moved even with no token count.
    expect(event?.credits).toBeGreaterThan(0);
    expect(event?.measurement).toBeNull();
    expect(event?.limitations.length).toBeGreaterThan(0);
  }, 20_000);

  it('exports the same filtered rows as a CSV, quoting what needs it', async () => {
    const parts = harness();
    await fund(parts.wallet, 200);
    await chargeChat(parts, { key: 'h1', projectId: 'alpha' });
    await chargeChat(parts, { key: 'h2', projectId: 'beta' });

    const alpha = await parts.history.exportCsv({ ownerRef: OWNER }, { projectId: 'alpha' });
    const lines = alpha.csv.trim().split('\n');
    expect(lines[0]).toContain('occurred_at');
    expect(lines[0]).toContain('credits');
    expect(alpha.rows).toBe(1);
    expect(alpha.truncated).toBe(false);
    expect(lines[1]).toContain('alpha');
    expect(lines[1]).not.toContain('beta');

    const everything = await parts.history.exportCsv({ ownerRef: OWNER }, {});
    expect(everything.rows).toBe(2);
  }, 20_000);

  it('walks infrastructure records as measurements, not credits', async () => {
    const parts = harness();
    await fund(parts.wallet, 50);
    await parts.usage.recordUsage({
      ownerRef: OWNER,
      category: 'file_storage',
      operation: 'file.upload',
      resource: 'notes.txt',
      quantity: 2048,
      operationKey: 'upload-notes',
      source: 'measured',
    });

    const page = await parts.history.history(
      { ownerRef: OWNER },
      { categories: ['infrastructure'], limit: 10 },
    );
    const event = page.events.find((entry) => entry.source === 'infrastructure');
    expect(event).toBeDefined();
    expect(event?.movement).toBe('measurement');
    expect(event?.credits).toBe(0);
    expect(event?.measurement?.unit).toBe('bytes');
    // Measurements do not share the charge counter, so no total is claimed.
    expect(page.total).toBeNull();
  }, 20_000);

  it('refuses a range that is backwards or longer than a year', async () => {
    const parts = harness();
    await expect(
      parts.history.history({ ownerRef: OWNER }, { from: '2026-05-02', to: '2026-05-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      parts.history.history({ ownerRef: OWNER }, { from: '2020-01-01', to: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
  }, 20_000);
});

describe('usage history routes (Step 58)', () => {
  const build = (parts: Harness) => {
    const app = Fastify({ logger: false });
    registerUsageHistoryRoutes(app, { history: parts.history });
    return app;
  };

  it('scopes every read to the caller and answers another owner with nothing', async () => {
    const parts = harness();
    await fund(parts.wallet, 200);
    await chargeChat(parts, { key: 'r1' });
    const app = build(parts);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/usage-history',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.body).events.length).toBeGreaterThan(0);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/usage-history',
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(theirs.statusCode).toBe(200);
    expect(JSON.parse(theirs.body).events).toEqual([]);

    const theirExport = await app.inject({
      method: 'GET',
      url: '/api/usage-history/export.csv',
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(theirExport.statusCode).toBe(200);
    expect(theirExport.body.trim().split('\n')).toHaveLength(1);

    await app.close();
  }, 20_000);

  it('streams the export as a CSV attachment and marks a partial one', async () => {
    const parts = harness({ scanCap: 2, exportCap: 2 });
    await fund(parts.wallet, 300);
    for (let index = 0; index < 4; index += 1) {
      await chargeChat(parts, { key: `r2-${index}` });
    }
    const app = build(parts);

    const response = await app.inject({
      method: 'GET',
      url: '/api/usage-history/export.csv',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(String(response.headers['content-disposition'])).toContain('attachment');
    expect(response.headers['x-veltravia-export-truncated']).toBe('true');
    expect(response.body.trim().split('\n').length).toBe(3);

    await app.close();
  }, 20_000);

  it('refuses an invented category rather than silently returning everything', async () => {
    const parts = harness();
    const app = build(parts);
    const response = await app.inject({
      method: 'GET',
      url: `/api/usage-history?category=not-a-category`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('INVALID_FILTER');
    await app.close();
  }, 20_000);
});

/**
 * The date and search filters belong in SQL. This block proves they are there and
 * that they narrow a real table, using the same store the deployment uses.
 */
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

describeDb('usage history over postgres', () => {
  it('filters charges by range and search inside the query', async () => {
    const { prepareIsolatedTestSchema, runWithOwner } = await import('@veltravia/storage-postgres');
    const url = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'usage-history')) ?? '';
    const persistence = await createPersistence({ url });
    try {
      // Postgres stores refuse a read or write outside an owner scope; the
      // deployment binds the caller before it touches one, so the test does too.
      await runWithOwner(OWNER, async () => {
        const wallet = createWalletService({ env, store: persistence.stores?.wallet });
        const messageCredits = createMessageCreditService({
          env,
          store: persistence.stores?.messageCredits,
          wallet,
          planOf: async () => 'paid',
        });
        await wallet.credit({
          ownerRef: OWNER,
          amount: 100,
          kind: 'grant',
          reason: 'test funding',
          actor: 'test',
          idempotencyKey: 'pg-fund-0001',
        });
        const reserved = await messageCredits.reserve({
          ownerRef: OWNER,
          kind: 'chat.message',
          idempotencyKey: 'pg-charge-0001',
          modelId: 'openai/gpt-4o-mini',
          providerId: 'openai',
        });
        await messageCredits.commit({
          ownerRef: OWNER,
          chargeId: reserved.charge.id,
          measurement: { inputTokens: 10, outputTokens: 5, source: 'provider' },
        });

        const inside = await messageCredits.charges(
          { ownerRef: OWNER },
          { limit: 10, since: '2000-01-01T00:00:00.000Z', until: '2999-01-01T00:00:00.000Z' },
        );
        expect((inside as { charges: unknown[] }).charges).toHaveLength(1);

        const outside = await messageCredits.charges(
          { ownerRef: OWNER },
          { limit: 10, since: '2000-01-01T00:00:00.000Z', until: '2000-02-01T00:00:00.000Z' },
        );
        expect((outside as { charges: unknown[] }).charges).toHaveLength(0);

        const searched = await messageCredits.charges(
          { ownerRef: OWNER },
          { limit: 10, query: 'gpt-4o' },
        );
        expect((searched as { charges: unknown[] }).charges).toHaveLength(1);

        const missed = await messageCredits.charges(
          { ownerRef: OWNER },
          { limit: 10, query: 'nothing-like-this' },
        );
        expect((missed as { charges: unknown[] }).charges).toHaveLength(0);
      });
    } finally {
      await persistence.close();
    }
  }, 60_000);
});

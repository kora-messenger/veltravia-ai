/**
 * The primitives, on their own.
 *
 * These are unit tests of the rules the API will rely on: a key means one
 * operation, a lease means one holder, an event key means one side effect, and a
 * decision is made from records. The database-backed behaviour they stand on is
 * proved separately in storage/postgres.
 */

import { describe, expect, it } from 'vitest';

import {
  EventInbox,
  IdempotencyGuard,
  InMemoryEventInbox,
  InMemoryIdempotencyStore,
  InMemoryLeaseStore,
  LeaseCoordinator,
  buildReliabilityHealth,
  decideSweep,
  eventKeyFor,
  fingerprintRequest,
  isAbandoned,
  leaseExpired,
  stableJson,
} from './index.js';

function clock(start = '2026-11-08T09:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

function guard(store = new InMemoryIdempotencyStore()) {
  const time = clock();
  return {
    store,
    time,
    guard: new IdempotencyGuard(store, { now: time.now, newOperationId: counter('op') }),
  };
}

describe('idempotency', () => {
  it('claims once and replays the stored answer for the same request', async () => {
    const { guard: idempotent, store } = guard();
    const fingerprint = fingerprintRequest({ projectId: 'p1', request: 'build it' });

    const first = await idempotent.begin({
      ownerRef: 'o1',
      scope: 'POST /api/executions',
      key: 'k1',
      fingerprint,
    });
    expect(first.outcome).toBe('claimed');
    if (first.outcome !== 'claimed') throw new Error('unreachable');
    await idempotent.complete(first.record, { status: 201, body: { execution: { id: 'exe_1' } } });

    const again = await idempotent.begin({
      ownerRef: 'o1',
      scope: 'POST /api/executions',
      key: 'k1',
      fingerprint,
    });
    expect(again.outcome).toBe('replay');
    if (again.outcome !== 'replay') throw new Error('unreachable');
    expect(again.record.response).toEqual({ status: 201, body: { execution: { id: 'exe_1' } } });

    // One record, so one operation happened.
    expect(await store.list('o1', {})).toHaveLength(1);
  });

  it('refuses the same key with a different request instead of replaying it', async () => {
    const { guard: idempotent } = guard();
    const first = await idempotent.begin({
      ownerRef: 'o1',
      scope: 'POST /api/executions',
      key: 'k1',
      fingerprint: fingerprintRequest({ request: 'add tests' }),
    });
    if (first.outcome !== 'claimed') throw new Error('unreachable');
    await idempotent.complete(first.record, { status: 201, body: { id: 'exe_1' } });

    const conflict = await idempotent.begin({
      ownerRef: 'o1',
      scope: 'POST /api/executions',
      key: 'k1',
      fingerprint: fingerprintRequest({ request: 'delete everything' }),
    });
    expect(conflict.outcome).toBe('conflict');
  });

  it('refuses a second attempt while the first is still running', async () => {
    const { guard: idempotent } = guard();
    const fingerprint = fingerprintRequest({ request: 'same' });
    await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    const second = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    expect(second.outcome).toBe('in_flight');
  });

  it('lets a failed attempt be retried with the same key', async () => {
    const { guard: idempotent } = guard();
    const fingerprint = fingerprintRequest({ request: 'same' });
    const first = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    if (first.outcome !== 'claimed') throw new Error('unreachable');
    await idempotent.fail(first.record, {
      code: 'EXECUTION_CONFLICT',
      message: 'changed underneath',
    });

    const retry = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    expect(retry.outcome).toBe('claimed');
    if (retry.outcome !== 'claimed') throw new Error('unreachable');
    expect(retry.record.operationId).not.toBe(first.record.operationId);
  });

  it('reclaims an in-flight record whose process stopped renewing it', async () => {
    const { guard: idempotent, time } = guard();
    const fingerprint = fingerprintRequest({ request: 'same' });
    await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    time.advance(61_000);
    const reclaimed = await idempotent.begin({
      ownerRef: 'o1',
      scope: 's',
      key: 'k1',
      fingerprint,
    });
    expect(reclaimed.outcome).toBe('claimed');
  });

  it('only lets the owning attempt record its outcome', async () => {
    const { guard: idempotent, store, time } = guard();
    const fingerprint = fingerprintRequest({ request: 'same' });
    const first = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    if (first.outcome !== 'claimed') throw new Error('unreachable');
    time.advance(61_000);
    const second = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'k1', fingerprint });
    if (second.outcome !== 'claimed') throw new Error('unreachable');

    // The abandoned attempt finishes late; it must not overwrite the new one.
    await idempotent.complete(first.record, { status: 200, body: { stale: true } });
    const stored = await store.get('o1', 's', 'k1');
    expect(stored?.status).toBe('in_progress');
    await idempotent.complete(second.record, { status: 200, body: { fresh: true } });
    expect((await store.get('o1', 's', 'k1'))?.response).toEqual({
      status: 200,
      body: { fresh: true },
    });
  });

  it('keeps one owner\u2019s key out of another owner\u2019s records', async () => {
    const { guard: idempotent, store } = guard();
    const fingerprint = fingerprintRequest({ request: 'same' });
    const mine = await idempotent.begin({ ownerRef: 'o1', scope: 's', key: 'shared', fingerprint });
    if (mine.outcome !== 'claimed') throw new Error('unreachable');
    await idempotent.complete(mine.record, { status: 201, body: { owner: 'o1' } });

    const theirs = await idempotent.begin({
      ownerRef: 'o2',
      scope: 's',
      key: 'shared',
      fingerprint,
    });
    expect(theirs.outcome).toBe('claimed');
    expect(await store.get('o2', 's', 'shared')).not.toBeNull();
    expect(await store.get('o1', 's', 'shared')).not.toBeNull();
    expect(await store.list('o2', {})).toHaveLength(1);
  });

  it('fingerprints the same body the same way regardless of key order', () => {
    expect(fingerprintRequest({ a: 1, b: [2, 3] })).toBe(fingerprintRequest({ b: [2, 3], a: 1 }));
    expect(fingerprintRequest({ a: 1 })).not.toBe(fingerprintRequest({ a: 2 }));
    expect(stableJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
});

describe('leases', () => {
  it('gives one holder the resource and refuses the other', async () => {
    const store = new InMemoryLeaseStore();
    const time = clock();
    const first = new LeaseCoordinator(store, { now: time.now, holder: 'api-a' });
    const second = new LeaseCoordinator(store, { now: time.now, holder: 'api-b' });

    expect(await first.claim('o1', 'execution:exe_1')).not.toBeNull();
    expect(await second.claim('o1', 'execution:exe_1')).toBeNull();

    // The refused holder is told why rather than doing the work twice.
    const outcome = await second.withLease('o1', 'execution:exe_1', async () => 'ran');
    expect(outcome).toEqual({ held: false });

    expect(await first.release('o1', 'execution:exe_1')).toBe(true);
    expect(await second.claim('o1', 'execution:exe_1')).not.toBeNull();
  });

  it('lets another holder take over once the lease has run out', async () => {
    const store = new InMemoryLeaseStore();
    const time = clock();
    const first = new LeaseCoordinator(store, { now: time.now, holder: 'api-a', ttlMs: 30_000 });
    const second = new LeaseCoordinator(store, { now: time.now, holder: 'api-b' });
    const lease = await first.claim('o1', 'execution:exe_1');
    if (lease === null) throw new Error('unreachable');

    time.advance(29_000);
    expect(await second.claim('o1', 'execution:exe_1')).toBeNull();
    time.advance(2_000);
    expect(leaseExpired(lease, time.now().toISOString())).toBe(true);

    const taken = await second.claim('o1', 'execution:exe_1');
    expect(taken?.holder).toBe('api-b');
    // The old holder can no longer renew or release what it lost.
    expect(await first.renew('o1', 'execution:exe_1')).toBeNull();
    expect(await first.release('o1', 'execution:exe_1')).toBe(false);
  });

  it('renews only for the holder that still owns the lease', async () => {
    const store = new InMemoryLeaseStore();
    const time = clock();
    const holder = new LeaseCoordinator(store, { now: time.now, holder: 'api-a', ttlMs: 10_000 });
    await holder.claim('o1', 'task:t1');
    time.advance(8_000);
    const renewed = await holder.renew('o1', 'task:t1');
    expect(renewed?.expiresAt).toBe(
      new Date(Date.parse(time.now().toISOString()) + 10_000).toISOString(),
    );
    const other = new LeaseCoordinator(store, { now: time.now, holder: 'api-b' });
    expect(await other.renew('o1', 'task:t1')).toBeNull();
  });
});

describe('event inbox', () => {
  it('runs a side effect once and treats the duplicate as a no-op', async () => {
    const store = new InMemoryEventInbox();
    const time = clock();
    const inbox = new EventInbox(store, { now: time.now });
    let ran = 0;
    const handle = async (): Promise<void> => {
      ran += 1;
    };
    const event = {
      ownerRef: 'o1',
      eventKey: eventKeyFor('recovery_case', 'w1'),
      topic: 'recovery_case',
      payload: { workerId: 'w1' },
      handle,
    };
    expect(await inbox.deliver(event)).toBe('processed');
    expect(await inbox.deliver(event)).toBe('duplicate');
    expect(ran).toBe(1);
    expect(await store.list('o1', {})).toHaveLength(1);
  });

  it('records a failure with a retry time and retries it later', async () => {
    const store = new InMemoryEventInbox();
    const time = clock();
    const inbox = new EventInbox(store, { now: time.now, retryBaseMs: 1_000 });
    let attempts = 0;
    const event = {
      ownerRef: 'o1',
      eventKey: eventKeyFor('integration', 'cs1'),
      topic: 'integration',
      payload: {},
      handle: async (): Promise<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error('project locked');
      },
    };
    expect(await inbox.deliver(event)).toBe('failed');
    const stored = await store.get('o1', event.eventKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.lastError).toContain('project locked');
    expect(await inbox.deliver(event)).toBe('duplicate');

    time.advance(1_500);
    expect(await inbox.deliver(event)).toBe('processed');
    expect(attempts).toBe(2);
  });
});

describe('sweep decision', () => {
  const base = {
    executionId: 'exe_1',
    status: 'executing',
    lastActivityAt: '2026-11-08T08:00:00.000Z',
    leaseHolder: null,
    leaseExpired: false,
    workers: [],
    tasks: [],
  } as const;

  it('leaves a finished execution alone', () => {
    const decision = decideSweep({ ...base, status: 'completed' });
    expect(decision.action).toBe('leave');
  });

  it('skips an execution another holder is working on', () => {
    const decision = decideSweep({
      ...base,
      leaseHolder: 'api-a',
      leaseExpired: false,
    });
    expect(decision.action).toBe('leave');
    expect(decision.reason).toContain('Another holder');
  });

  it('recovers workers that stopped reporting instead of assuming they finished', () => {
    const decision = decideSweep({
      ...base,
      workers: [{ workerId: 'w1', status: 'running', heartbeatAgeMs: 120_000 }],
    });
    expect(decision.action).toBe('recover');
    expect(decision.evidence.join(' ')).toContain('w1');
  });

  it('waits for the owner when work is blocked', () => {
    const decision = decideSweep({
      ...base,
      tasks: [{ taskId: 't1', status: 'blocked' }],
    });
    expect(decision.action).toBe('await_owner');
    expect(decision.ownerAction).not.toBeNull();
  });

  it('resumes by re-reading evidence, never by asserting success', () => {
    const decision = decideSweep(base);
    expect(decision.action).toBe('resume');
    expect(decision.reason).toContain('re-read');
  });

  it('treats a quiet execution without a lease as abandoned', () => {
    const at = '2026-11-08T09:00:00.000Z';
    expect(isAbandoned(base, at)).toBe(true);
    expect(isAbandoned({ ...base, lastActivityAt: '2026-11-08T08:59:30.000Z' }, at)).toBe(false);
    expect(isAbandoned({ ...base, leaseHolder: 'api-a' }, at)).toBe(false);
  });
});

describe('reliability health', () => {
  const at = '2026-11-08T09:00:00.000Z';
  const emptyInput = {
    at,
    durable: true,
    executions: [],
    workers: [],
    tasks: [],
    verifications: [],
    integrations: [],
    recoveries: [],
    leases: [],
    idempotency: [],
    events: [],
    staleHeartbeatMs: 90_000,
    maxOpenExecutions: 10,
  } as const;

  it('reports a healthy system without inventing a cause', () => {
    const health = buildReliabilityHealth({ ...emptyInput });
    expect(health.findings.map((finding) => finding.code)).toEqual(['HEALTHY']);
    expect(health.queue.openExecutions).toBe(0);
  });

  it('counts expired leases and abandoned executions from the records', () => {
    const health = buildReliabilityHealth({
      ...emptyInput,
      executions: [
        {
          executionId: 'exe_1',
          status: 'executing',
          updatedAt: '2026-11-08T08:00:00.000Z',
          startedAt: '2026-11-08T07:00:00.000Z',
        },
      ],
      leases: [
        {
          ownerRef: 'o1',
          resource: 'execution:exe_1',
          holder: 'api-a',
          acquiredAt: '2026-11-08T08:00:00.000Z',
          renewedAt: '2026-11-08T08:00:00.000Z',
          expiresAt: '2026-11-08T08:00:30.000Z',
          releasedAt: null,
          note: null,
        },
      ],
    });
    expect(health.leases.expired).toBe(1);
    expect(health.abandoned.map((entry) => entry.executionId)).toEqual(['exe_1']);
    expect(health.findings.map((finding) => finding.code)).toContain('LEASES_EXPIRED');
  });

  it('says out loud when coordination is not durable', () => {
    const health = buildReliabilityHealth({ ...emptyInput, durable: false });
    const finding = health.findings.find((entry) => entry.code === 'RELIABILITY_NOT_DURABLE');
    expect(finding?.level).toBe('attention');
  });
});

/**
 * Infrastructure metering (Step 57).
 *
 * Three numbers Step 52 could not obtain, and one rule that matters more than any
 * of them: a measurement is recorded only when this process actually observed it.
 * An unmeasured byte is missing, not zero, and never a guess.
 */

import { describe, expect, it } from 'vitest';

import { createInfrastructureMetering } from './infrastructure-metering.js';
import { createUsageService } from './usage-service.js';

const env = { VELTRAVIA_DEPLOYMENT_MODE: 'production' } as NodeJS.ProcessEnv;

function harness(start = '2026-11-12T10:00:05.000Z') {
  let clock = new Date(start);
  const now = () => clock;
  const usage = createUsageService({ env, now });
  const metering = createInfrastructureMetering({ usage, now });
  return {
    usage,
    metering,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('file storage', () => {
  it('records the bytes that were accepted, and releases them on delete', async () => {
    const { usage, metering } = harness();
    const added = await metering.recordStorage({
      ownerRef: 'owner-a',
      fileId: 'file_1',
      bytes: 2048,
      direction: 'added',
    });
    expect(added?.category).toBe('file_storage');
    expect(added?.quantity).toBe(2048);
    expect(added?.source).toBe('measured');

    const removed = await metering.recordStorage({
      ownerRef: 'owner-a',
      fileId: 'file_1',
      bytes: 2048,
      direction: 'removed',
    });
    expect(removed?.quantity).toBe(2048);
    expect(removed?.detail['signed']).toBe(-2048);

    const records = await usage.records('owner-a');
    expect(records).toHaveLength(2);
  });

  it('writes nothing when the size was never measured', async () => {
    const { usage, metering } = harness();
    expect(
      await metering.recordStorage({
        ownerRef: 'owner-a',
        fileId: 'file_2',
        bytes: 0,
        direction: 'added',
      }),
    ).toBeNull();
    expect(
      await metering.recordStorage({
        ownerRef: 'owner-a',
        fileId: 'file_2',
        bytes: Number.NaN,
        direction: 'added',
      }),
    ).toBeNull();
    expect(await usage.records('owner-a')).toHaveLength(0);
  });

  it('counts the same file event once, however often it is reported', async () => {
    const { usage, metering } = harness();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await metering.recordStorage({
        ownerRef: 'owner-a',
        fileId: 'file_3',
        bytes: 512,
        direction: 'added',
      });
    }
    const records = await usage.records('owner-a');
    expect(records).toHaveLength(1);
  });
});

describe('bandwidth', () => {
  it('accumulates in memory and writes one record per owner per minute', async () => {
    const { usage, metering, advance } = harness();
    metering.observeTransfer({ ownerRef: 'owner-a', requestBytes: 100, responseBytes: 400 });
    metering.observeTransfer({ ownerRef: 'owner-a', requestBytes: 50, responseBytes: 250 });
    // Nothing is written per request: the ledger would be unreadable.
    expect(await usage.records('owner-a')).toHaveLength(0);
    expect(metering.stats().bufferedBytes).toBe(800);

    const flushed = await metering.flushBandwidth();
    expect(flushed).toMatchObject({ owners: 1, bytes: 800 });

    const records = await usage.records('owner-a');
    expect(records).toHaveLength(1);
    expect(records[0]?.category).toBe('bandwidth');
    expect(records[0]?.quantity).toBe(800);
    expect(records[0]?.detail['requestBytes']).toBe(150);
    expect(records[0]?.detail['responseBytes']).toBe(650);

    // A second flush with nothing buffered writes nothing.
    expect(await metering.flushBandwidth()).toMatchObject({ owners: 0, bytes: 0 });
    expect(await usage.records('owner-a')).toHaveLength(1);

    // Next minute, next sample.
    advance(60_000);
    metering.observeTransfer({ ownerRef: 'owner-a', responseBytes: 10 });
    await metering.flushBandwidth();
    expect(await usage.records('owner-a')).toHaveLength(2);
  });

  it('keeps owners apart and ignores a transfer with no measured bytes', async () => {
    const { usage, metering } = harness();
    metering.observeTransfer({ ownerRef: 'owner-a', responseBytes: 100 });
    metering.observeTransfer({ ownerRef: 'owner-b', responseBytes: 300 });
    metering.observeTransfer({ ownerRef: 'owner-c', requestBytes: 0, responseBytes: 0 });
    metering.observeTransfer({ ownerRef: 'owner-c', requestBytes: -5 });
    await metering.flushBandwidth();

    expect((await usage.records('owner-a'))[0]?.quantity).toBe(100);
    expect((await usage.records('owner-b'))[0]?.quantity).toBe(300);
    expect(await usage.records('owner-c')).toHaveLength(0);
  });

  it('samples on a timer and stops when told to', async () => {
    const { metering } = harness();
    const timer = metering.start(0);
    // 0 is the honest default for a harness: no timer, nothing written.
    expect(metering.stats().bufferedOwners).toBe(0);
    timer.stop();
    const running = metering.start(15);
    running.stop();
    expect(metering.stats().flushedBytes).toBe(0);
  });
});

describe('realtime streams', () => {
  it('counts a live connection and records it when it closes', async () => {
    const { usage, metering, advance } = harness();
    const stream = metering.openStream({ ownerRef: 'owner-a', kind: 'chat.stream' });
    expect(metering.liveStreams('owner-a')).toBe(1);
    expect(metering.liveStreams('owner-b')).toBe(0);

    stream.event();
    stream.event();
    advance(5_000);
    await stream.close('stream-ended');

    expect(metering.liveStreams('owner-a')).toBe(0);
    const records = await usage.records('owner-a');
    expect(records).toHaveLength(1);
    expect(records[0]?.category).toBe('realtime');
    expect(records[0]?.quantity).toBe(1);
    expect(records[0]?.detail['events']).toBe(2);
    expect(records[0]?.detail['durationMs']).toBe(5_000);
  });

  it('closes once, so a stream cannot be counted twice', async () => {
    const { usage, metering } = harness();
    const stream = metering.openStream({ ownerRef: 'owner-a' });
    await stream.close();
    await stream.close();
    stream.event();
    expect(await usage.records('owner-a')).toHaveLength(1);
    expect(metering.stats().liveStreams).toBe(0);
  });
});

describe('the meter refuses numbers it cannot stand behind', () => {
  it('rejects a negative or non-finite quantity instead of writing it', async () => {
    const { usage } = harness();
    await expect(
      usage.recordUsage({
        ownerRef: 'owner-a',
        category: 'bandwidth',
        operation: 'http.transfer',
        quantity: -1,
        operationKey: 'bad:1',
      }),
    ).rejects.toThrow(/finite, non-negative/);
    await expect(
      usage.recordUsage({
        ownerRef: 'owner-a',
        category: 'bandwidth',
        operation: 'http.transfer',
        quantity: Number.POSITIVE_INFINITY,
        operationKey: 'bad:2',
      }),
    ).rejects.toThrow(/finite, non-negative/);
    expect(await usage.records('owner-a')).toHaveLength(0);
  });

  it('requires an operation key and a known category', async () => {
    const { usage } = harness();
    await expect(
      usage.recordUsage({
        ownerRef: 'owner-a',
        category: 'bandwidth',
        operation: 'http.transfer',
        quantity: 1,
        operationKey: '   ',
      }),
    ).rejects.toThrow(/operation key/i);
    await expect(
      usage.recordUsage({
        ownerRef: 'owner-a',
        // @ts-expect-error - not a metered category
        category: 'guessing',
        operation: 'http.transfer',
        quantity: 1,
        operationKey: 'k',
      }),
    ).rejects.toThrow(/not a metered category/);
  });
});

/**
 * The scheduled hold sweep (Step 56).
 *
 * The timer is injected, so these tests drive ticks instead of waiting for them
 * and can prove the two properties a background job must have: it does not stack
 * a second sweep on top of a slow one, and a failed tick does not disarm it.
 */

import { describe, expect, it } from 'vitest';

import type { IntegrationCreditService } from './integration-credit-service.js';
import {
  DEFAULT_SWEEP_INTERVAL_SECONDS,
  describeSweep,
  startIntegrationCreditSweep,
  sweepIntervalSeconds,
} from './integration-credit-sweep.js';

const envWith = (value?: string): NodeJS.ProcessEnv =>
  value === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ VELTRAVIA_INTEGRATION_SWEEP_INTERVAL_SECONDS: value } as NodeJS.ProcessEnv);

interface Harness {
  readonly handlers: (() => void)[];
  readonly timers: {
    setInterval(handler: () => void, milliseconds: number): unknown;
    clearInterval(handle: unknown): void;
    unref(handle: unknown): void;
  };
  readonly cleared: () => boolean;
  readonly unrefed: () => boolean;
  readonly intervals: () => number[];
}

function fakeTimers(): Harness {
  const handlers: (() => void)[] = [];
  const intervals: number[] = [];
  let cleared = false;
  let unrefed = false;
  return {
    handlers,
    intervals: () => intervals,
    cleared: () => cleared,
    unrefed: () => unrefed,
    timers: {
      setInterval: (handler, milliseconds) => {
        handlers.push(handler);
        intervals.push(milliseconds);
        return handlers.length;
      },
      clearInterval: () => {
        cleared = true;
      },
      unref: () => {
        unrefed = true;
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const creditsWith = (
  sweepAll: IntegrationCreditService['sweepAll'],
): Pick<IntegrationCreditService, 'sweepAll'> => ({ sweepAll });

describe('the sweep interval', () => {
  it('defaults to five minutes when nothing is configured', () => {
    expect(sweepIntervalSeconds(envWith())).toBe(DEFAULT_SWEEP_INTERVAL_SECONDS);
    expect(sweepIntervalSeconds(envWith('  '))).toBe(DEFAULT_SWEEP_INTERVAL_SECONDS);
  });

  it('reads the configured value, and disables itself on zero', () => {
    expect(sweepIntervalSeconds(envWith('45'))).toBe(45);
    expect(sweepIntervalSeconds(envWith('0'))).toBe(0);
  });

  it('treats an unusable value as disabled rather than as a default', () => {
    expect(sweepIntervalSeconds(envWith('soon'))).toBe(0);
    expect(sweepIntervalSeconds(envWith('-30'))).toBe(0);
  });
});

describe('the sweep timer', () => {
  it('schedules nothing when the interval is zero', () => {
    const harness = fakeTimers();
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => ({ owners: [], released: [] })),
      env: envWith('0'),
      timers: harness.timers,
    });
    expect(sweep).toBeNull();
    expect(harness.handlers).toHaveLength(0);
  });

  it('runs a sweep on its own tick and reports what it found', async () => {
    const harness = fakeTimers();
    const results: number[] = [];
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => ({
        owners: ['owner-a'],
        released: [],
      })),
      env: envWith('30'),
      timers: harness.timers,
      onRun: (result) => results.push(result.owners),
    });
    expect(sweep).not.toBeNull();
    expect(harness.intervals()).toEqual([30_000]);
    // A timer must never be the reason a process stays alive.
    expect(harness.unrefed()).toBe(true);

    harness.handlers[0]?.();
    await settle();
    expect(results).toEqual([1]);
  });

  it('does not start a second sweep while one is still running', async () => {
    const harness = fakeTimers();
    let calls = 0;
    let release: (() => void) | null = null;
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = () => resolve();
        });
        return { owners: [], released: [] };
      }),
      env: envWith('30'),
      timers: harness.timers,
    });

    harness.handlers[0]?.();
    harness.handlers[0]?.();
    await settle();
    expect(calls).toBe(1);
    // Once the slow sweep finishes, the timer is free again.
    expect(release).not.toBeNull();
    release!();
    await settle();
    harness.handlers[0]?.();
    await settle();
    expect(calls).toBe(2);
    sweep?.stop();
  });

  it('reports a failed tick and stays armed for the next one', async () => {
    const harness = fakeTimers();
    const failures: string[] = [];
    let attempt = 0;
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('database unavailable');
        return { owners: [], released: [] };
      }),
      env: envWith('30'),
      timers: harness.timers,
      onError: (error) => failures.push(error instanceof Error ? error.message : 'unknown'),
    });

    harness.handlers[0]?.();
    await settle();
    expect(failures).toEqual(['database unavailable']);

    harness.handlers[0]?.();
    await settle();
    expect(failures).toHaveLength(1);
    expect(attempt).toBe(2);
    // No error was reported for the second tick: the timer survived the first.
    sweep?.stop();
  });

  it('stops sweeping once it is stopped', async () => {
    const harness = fakeTimers();
    let calls = 0;
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => {
        calls += 1;
        return { owners: [], released: [] };
      }),
      env: envWith('30'),
      timers: harness.timers,
    });
    harness.handlers[0]?.();
    await settle();
    sweep?.stop();
    expect(harness.cleared()).toBe(true);
    harness.handlers[0]?.();
    await settle();
    expect(calls).toBe(1);
    // Stopping twice is not an error and does not clear anything twice.
    sweep?.stop();
  });

  it('can be run on demand without waiting for the timer', async () => {
    const harness = fakeTimers();
    const sweep = startIntegrationCreditSweep({
      integrationCredits: creditsWith(async () => ({ owners: ['a', 'b'], released: [] })),
      env: envWith('300'),
      timers: harness.timers,
    });
    await expect(sweep?.runOnce()).resolves.toEqual({ owners: 2, released: 0 });
    expect(harness.handlers).toHaveLength(1);
    sweep?.stop();
  });
});

describe('the sweep log line', () => {
  it('states what was looked at and what was given back', () => {
    expect(describeSweep({ owners: 2, released: 3 }, new Date('2026-11-12T08:00:00.000Z'))).toBe(
      'integration hold sweep at 2026-11-12T08:00:00.000Z: 2 account(s), 3 hold(s) released',
    );
  });
});

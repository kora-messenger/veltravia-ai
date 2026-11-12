/**
 * The scheduled hold sweep (Step 56).
 *
 * A hold that nobody settles is credit the account cannot spend. The routes
 * already sweep on demand, but "on demand" means somebody has to remember, and
 * the person who abandoned a request is the least likely to come back for it.
 * This timer does it instead: every `VELTRAVIA_INTEGRATION_SWEEP_INTERVAL_SECONDS`
 * it releases expired holds for every account that still holds credit.
 *
 * Three rules keep a background timer from becoming a background problem:
 *
 *  1. It only releases. A sweep never settles, never charges and never refunds,
 *     so a tick can cost nothing but a few reads.
 *  2. Ticks do not stack. A slow sweep keeps the next tick from starting, so a
 *     full table cannot turn into overlapping sweeps on the same rows.
 *  3. A failed tick is reported and the timer stays armed. A database hiccup
 *     should not silently end hold expiry for the rest of the process's life.
 *
 * The interval is disabled by setting it to `0`, which is what a test harness or
 * a desktop build wants. The handle is unref'd so a tick never keeps the process
 * alive on its own.
 */

import type { IntegrationCreditService } from './integration-credit-service.js';

/** Five minutes: a hold lives fifteen, so an abandoned one is noticed promptly. */
export const DEFAULT_SWEEP_INTERVAL_SECONDS = 300;

export interface IntegrationCreditSweepResult {
  /** How many accounts were looked at. */
  readonly owners: number;
  /** How many holds were given back. */
  readonly released: number;
}

export interface IntegrationCreditSweep {
  readonly intervalSeconds: number;
  /** One sweep, now, ignoring the timer. Used by tests and by a manual tick. */
  runOnce(): Promise<IntegrationCreditSweepResult>;
  stop(): void;
}

interface SweepTimers {
  setInterval(handler: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  unref(handle: unknown): void;
}

const nodeTimers: SweepTimers = {
  setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  unref: (handle) => {
    const timer = handle as { unref?: () => void };
    timer.unref?.();
  },
};

export interface IntegrationCreditSweepOptions {
  readonly integrationCredits: Pick<IntegrationCreditService, 'sweepAll'>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Called after every tick that completed, including one that released nothing. */
  readonly onRun?: ((result: IntegrationCreditSweepResult) => void) | undefined;
  /** Called with whatever a tick threw. The timer stays armed. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Injected so a test can drive time instead of waiting for it. */
  readonly timers?: SweepTimers | undefined;
}

/**
 * The configured interval in seconds. `0` (or anything unusable) disables the
 * sweep; a negative or non-numeric value is treated as `0` rather than quietly
 * falling back to a default the operator did not ask for.
 */
export function sweepIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['VELTRAVIA_INTEGRATION_SWEEP_INTERVAL_SECONDS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_INTERVAL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function startIntegrationCreditSweep(
  options: IntegrationCreditSweepOptions,
): IntegrationCreditSweep | null {
  const intervalSeconds = sweepIntervalSeconds(options.env);
  if (intervalSeconds === 0) return null;

  const timers = options.timers ?? nodeTimers;
  let handle: unknown = null;
  let stopped = false;
  let running = false;

  const runOnce = async (): Promise<IntegrationCreditSweepResult> => {
    const swept = await options.integrationCredits.sweepAll();
    return { owners: swept.owners.length, released: swept.released.length };
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runOnce();
      options.onRun?.(result);
    } catch (error) {
      // A sweep is best effort: report it and try again on the next tick.
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  handle = timers.setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);
  timers.unref(handle);

  return {
    intervalSeconds,
    runOnce,
    stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
  };
}

/** A one-line summary for a log sink: what a tick looked at and what it gave back. */
export function describeSweep(result: IntegrationCreditSweepResult, at: Date = new Date()): string {
  return `integration hold sweep at ${at.toISOString()}: ${result.owners} account(s), ${result.released} hold(s) released`;
}

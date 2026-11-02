import { describe, expect, it, vi } from 'vitest';
import type { AgentActivityEvent, FinalAgentReport } from '@veltravia/shared';
import { RunFollower, type FollowUpdate } from './followRun';

/**
 * The follower is the part that has to be right when the network is not.
 *
 * Every test here drives it with a fake stream and a fake snapshot, so the
 * failures are the ones under test - a dropped socket, a missed row, a run that
 * ends while the page is looking away - and not whatever the machine's network
 * happened to do.
 */

const NOW = '2026-11-02T10:00:00.000Z';

function activity(
  id: string,
  sequence: number,
  status: AgentActivityEvent['status'] = 'succeeded',
): AgentActivityEvent {
  return {
    eventId: `${id}:${status}`,
    runId: 'run-1',
    sequence,
    activityId: id,
    parentActivityId: null,
    category: 'searching',
    title: `Step ${id}`,
    status,
    safeSummary: `Step ${id}`,
    startedAt: NOW,
    completedAt: status === 'running' ? null : NOW,
    durationMs: status === 'running' ? null : 120,
    safeInput: null,
    safeOutput: null,
    error: null,
    retryCount: 0,
  };
}

const report: FinalAgentReport = {
  status: 'completed',
  summary: 'Done.',
  completed: [],
  filesChanged: { created: [], updated: [], deleted: [] },
  validation: { tests: 'not_run', lint: 'not_run', types: 'not_run', build: 'not_run' },
  failures: [],
  recovery: [],
  remaining: [],
  generatedAt: NOW,
};

interface Harness {
  readonly updates: FollowUpdate[];
  readonly follower: RunFollower;
  readonly handlers: () => Parameters<NonNullable<Parameters<typeof RunFollower.prototype.start>>>;
  readonly push: (activity: AgentActivityEvent) => void;
  readonly fail: () => void;
  readonly finish: (status: string) => void;
  readonly closed: () => boolean;
}

function harness(snapshot: (call: number) => Promise<unknown>): Harness {
  let handlers: {
    onActivity: (activity: AgentActivityEvent) => void;
    onFinal: (report: FinalAgentReport | null, runStatus: string) => void;
    onConnection: (state: 'live' | 'reconnecting') => void;
  } | null = null;
  let closed = false;
  let calls = 0;
  const updates: FollowUpdate[] = [];
  const follower = new RunFollower({
    runId: 'run-1',
    onUpdate: (update) => updates.push(update),
    intervalMs: 10_000,
    stream: (_after, next) => {
      handlers = next;
      return { close: () => (closed = true) };
    },
    snapshot: async () => {
      calls += 1;
      return (await snapshot(calls)) as never;
    },
  });
  return {
    updates,
    follower,
    handlers: () => handlers as never,
    push: (item) => handlers?.onActivity(item),
    fail: () => handlers?.onConnection('reconnecting'),
    finish: (status) => handlers?.onFinal(report, status),
    closed: () => closed,
  };
}

describe('RunFollower', () => {
  it('streams rows live and merges them in sequence order', async () => {
    const { follower, updates, push } = harness(async () => null);
    follower.start();
    push(activity('a2', 2));
    push(activity('a1', 1));
    follower.stop();
    const last = updates.at(-1)!;
    expect(last.activities.map((row) => row.activityId)).toEqual(['a1', 'a2']);
    expect(last.connection).toBe('closed');
  });

  it('recovers the rows it missed while disconnected, without duplicating the ones it has', async () => {
    let calls = 0;
    const { follower, updates, push, fail } = harness(async () => {
      calls += 1;
      // First read: two rows. Second: the missed third row arrives as well.
      return {
        runId: 'run-1',
        runStatus: 'running',
        terminal: false,
        report: null,
        activities:
          calls === 1
            ? [activity('a1', 1), activity('a2', 2)]
            : [activity('a1', 1), activity('a2', 2), activity('a3', 3)],
      };
    });
    follower.start();
    push(activity('a1', 1));
    fail();
    await follower.poll();
    await follower.poll();
    follower.stop();

    const last = updates.at(-1)!;
    expect(last.activities.map((row) => row.activityId)).toEqual(['a1', 'a2', 'a3']);
    // And it said it was reconnecting at the point it was.
    expect(updates.some((update) => update.connection === 'reconnecting')).toBe(true);
  });

  it('stops when the run ends, and does not ask for anything more', async () => {
    const { follower, updates, finish, closed } = harness(async () => ({
      runId: 'run-1',
      runStatus: 'completed',
      terminal: true,
      report,
      activities: [activity('a1', 1)],
    }));
    follower.start();
    finish('completed');
    expect(closed()).toBe(true);
    const last = updates.at(-1)!;
    expect(last.terminal).toBe(true);
    expect(last.report).toEqual(report);
    expect(last.runStatus).toBe('completed');
    // A finished run is never polled again: nothing can change it.
    await follower.poll();
    expect(updates.at(-1)).toBe(last);
  });

  it('reads the run once at the start so a reconnect draws what it missed', async () => {
    let calls = 0;
    const { follower } = harness(async () => {
      calls += 1;
      return {
        runId: 'run-1',
        runStatus: 'running',
        terminal: false,
        report: null,
        activities: [activity('a1', 1)],
      };
    });
    follower.start();
    await Promise.resolve();
    await Promise.resolve();
    follower.stop();
    expect(calls).toBeGreaterThan(0);
  });

  it('treats a failed read as a connection problem, not a run problem', async () => {
    const { follower, updates } = harness(async () => {
      throw new Error('network down');
    });
    follower.start();
    await follower.poll();
    follower.stop();
    const last = updates.at(-1)!;
    expect(last.runStatus).toBeNull();
    expect(last.terminal).toBe(false);
  });

  it('gives up after its own ceiling instead of following for ever', async () => {
    const updates: FollowUpdate[] = [];
    const follower = new RunFollower({
      runId: 'run-1',
      onUpdate: (update) => updates.push(update),
      intervalMs: 10_000,
      maxPolls: 2,
      stream: () => ({ close: () => undefined }),
      snapshot: async () => ({
        runId: 'run-1',
        runStatus: 'running',
        terminal: false,
        report: null,
        activities: [],
      }),
    });
    follower.start();
    await follower.poll();
    await follower.poll();
    expect(updates.at(-1)!.connection).toBe('closed');
  });

  it('never reopens a finished row a late snapshot still carries as running', async () => {
    const { follower, updates, push } = harness(async () => null);
    follower.start();
    push(activity('a1', 1, 'running'));
    push(activity('a1', 1, 'succeeded'));
    push(activity('a1', 1, 'running'));
    follower.stop();
    const rows = updates.at(-1)!.activities;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('succeeded');
  });

  it('closes the stream exactly once when stopped', () => {
    const close = vi.fn();
    const follower = new RunFollower({
      runId: 'run-1',
      onUpdate: () => undefined,
      intervalMs: 10_000,
      stream: () => ({ close }),
      snapshot: async () => null,
    });
    follower.start();
    follower.stop();
    follower.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

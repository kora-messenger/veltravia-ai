import {
  mergeAgentActivities,
  type AgentActivityEvent,
  type FinalAgentReport,
} from '@veltravia/shared';
import { getActivitySnapshot, openActivityStream, type ActivityStream } from '../../api/activity';
import { isOffline } from '../../api/client';

/**
 * Follows one run, for as long as it has work left.
 *
 * Two sources, deliberately: a live stream for the rows as they happen, and a
 * slower snapshot poll underneath it. The stream is the fast path; the poll is
 * what makes the same code correct when a proxy buffers SSE, when the browser
 * has no EventSource, or when the tab was asleep for a minute. Both feed the
 * same merge, which orders by sequence and refuses to reopen a finished row, so
 * running them together cannot duplicate a line or unwind one.
 *
 * Nothing here starts or restarts a run. A reconnect re-reads a run the server
 * still owns; it never asks for the work again.
 */

/** The backup cadence. Slow enough to be cheap, fast enough to feel live. */
const POLL_MS = 2000;
/** A run that has stopped reporting is not followed for ever. */
const MAX_POLLS = 240;

export type FollowConnection = 'live' | 'reconnecting' | 'offline' | 'closed';

export interface FollowUpdate {
  readonly activities: readonly AgentActivityEvent[];
  readonly report: FinalAgentReport | null;
  readonly runStatus: string | null;
  readonly terminal: boolean;
  readonly connection: FollowConnection;
}

export interface RunFollowerOptions {
  readonly runId: string;
  readonly onUpdate: (update: FollowUpdate) => void;
  /** Injectable for tests: no sockets, no timers, same merge. */
  readonly stream?: (
    after: number,
    handlers: Parameters<typeof openActivityStream>[2],
  ) => ActivityStream;
  readonly snapshot?: (
    runId: string,
    after: number,
  ) => Promise<{
    readonly activities: readonly AgentActivityEvent[];
    readonly report: FinalAgentReport | null;
    readonly runStatus: string;
    readonly terminal: boolean;
  } | null>;
  readonly intervalMs?: number;
  readonly maxPolls?: number;
}

export class RunFollower {
  private activities: AgentActivityEvent[] = [];
  private report: FinalAgentReport | null = null;
  private runStatus: string | null = null;
  private terminal = false;
  private connection: FollowConnection = 'reconnecting';
  private stream: ActivityStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polls = 0;
  private stopped = false;

  constructor(private readonly options: RunFollowerOptions) {}

  /** Begins following. `after` is the highest sequence already on screen. */
  start(after = 0): void {
    if (this.stopped) return;
    const { runId } = this.options;
    const open =
      this.options.stream ?? ((after, handlers) => openActivityStream(runId, after, handlers));
    this.stream = open(after, {
      onActivity: (activity) => this.apply([activity]),
      onFinal: (report, runStatus) => {
        this.apply([], report, runStatus, true);
      },
      onConnection: (state) => this.setConnection(state),
    });
    const interval = this.options.intervalMs ?? POLL_MS;
    const timer = setInterval(() => void this.poll(), interval);
    // Node's timer can be unref'd so a test process is not held open; a browser
    // timer has no such method and does not need one.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
    // One immediate read so a reconnect draws what it missed without waiting a
    // whole beat.
    void this.poll();
  }

  /** Reads the run once, for the case where there is no stream at all. */
  async poll(): Promise<void> {
    if (this.stopped || this.terminal) return;
    if (this.polls >= (this.options.maxPolls ?? MAX_POLLS)) {
      this.stop('closed');
      return;
    }
    this.polls += 1;
    if (isOffline()) {
      this.setConnection('offline');
      return;
    }
    const read = this.options.snapshot ?? getActivitySnapshot;
    try {
      const snapshot = await read(this.options.runId, 0);
      if (snapshot === null || this.stopped) return;
      this.apply(snapshot.activities, snapshot.report, snapshot.runStatus, snapshot.terminal);
      if (this.connection !== 'live') this.setConnection('live');
    } catch {
      // A failed read is a connection problem, not a run problem: the server
      // still owns the run and the next beat asks again.
      this.setConnection(isOffline() ? 'offline' : 'reconnecting');
    }
  }

  /** Stops following. Used when a run finishes, or the person cancels. */
  stop(connection: FollowConnection = 'closed'): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stream?.close();
    this.stream = null;
    this.setConnection(connection);
  }

  private setConnection(connection: FollowConnection): void {
    if (this.stopped && connection !== 'closed') return;
    if (this.connection === connection && this.terminal) return;
    this.connection = connection;
    this.publish();
  }

  private apply(
    incoming: readonly AgentActivityEvent[],
    report?: FinalAgentReport | null,
    runStatus?: string,
    terminal?: boolean,
  ): void {
    if (this.stopped) return;
    this.activities = mergeAgentActivities(this.activities, incoming);
    if (report !== undefined) this.report = report;
    if (runStatus !== undefined) this.runStatus = runStatus;
    if (terminal === true) {
      this.terminal = true;
      this.stop('closed');
      return;
    }
    this.publish();
  }

  private publish(): void {
    this.options.onUpdate({
      activities: this.activities,
      report: this.report,
      runStatus: this.runStatus,
      terminal: this.terminal,
      connection: this.connection,
    });
  }
}

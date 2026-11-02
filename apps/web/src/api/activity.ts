import {
  parseAgentActivityEvent,
  parseAgentActivitySnapshot,
  parseFinalReport,
  type AgentActivityEvent,
  type AgentActivitySnapshot,
  type FinalAgentReport,
} from '@veltravia/shared';
import { apiRequest } from './client';
import { runtimeConfig } from '../config/runtime-config.js';

/**
 * The browser's side of Step 37: the activity stream.
 *
 * Two ways in, both reading the same server-derived rows:
 *
 * - `getActivitySnapshot` for a first look or a reconnect, with the last
 *   sequence the page holds so only what was missed comes back;
 * - `openActivityStream` for the live timeline, over EventSource so the browser
 *   does the reconnecting rather than a hand-written retry loop.
 *
 * Everything is validated on arrival. A malformed row is dropped rather than
 * drawn half-empty, because an activity with a missing status would otherwise
 * render as though it were still running.
 */

export interface StreamHandlers {
  readonly onActivity: (activity: AgentActivityEvent) => void;
  readonly onFinal: (report: FinalAgentReport | null, runStatus: string) => void;
  /** `live` once connected, `reconnecting` while the browser retries. */
  readonly onConnection: (state: 'live' | 'reconnecting') => void;
}

export interface ActivityStream {
  readonly close: () => void;
}

export async function getActivitySnapshot(
  runId: string,
  after = 0,
): Promise<AgentActivitySnapshot | null> {
  const raw = await apiRequest<unknown>(
    `/api/reasoning/runs/${encodeURIComponent(runId)}/activity?after=${after}`,
    { timeoutMs: 15_000 },
  );
  const parsed = parseAgentActivitySnapshot(raw);
  return parsed.ok ? parsed.value : null;
}

function streamUrl(runId: string, after: number): string {
  return `${runtimeConfig().apiBaseUrl}/api/reasoning/runs/${encodeURIComponent(
    runId,
  )}/activity/events?after=${after}`;
}

/**
 * Follows a run's timeline.
 *
 * Returns immediately; the socket opens in the background. `after` is the last
 * sequence already on screen, so a page that reconnects mid-run continues where
 * it stopped instead of replaying identical rows over the top of what the person
 * is reading.
 */
export function openActivityStream(
  runId: string,
  after: number,
  handlers: StreamHandlers,
): ActivityStream {
  if (typeof EventSource === 'undefined') {
    // No streaming support: the snapshot route still reports the run, so the
    // caller degrades to a slower poll rather than to a blank timeline.
    handlers.onConnection('reconnecting');
    return { close: () => undefined };
  }
  const source = new EventSource(streamUrl(runId, after));
  let closed = false;

  source.addEventListener('open', () => {
    if (!closed) handlers.onConnection('live');
  });

  source.addEventListener('activity', (event) => {
    if (closed) return;
    const message = event as MessageEvent<string>;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data as string);
    } catch {
      return;
    }
    const parsed = parseAgentActivityEvent(payload);
    if (parsed.ok) handlers.onActivity(parsed.value);
  });

  source.addEventListener('final', (event) => {
    if (closed) return;
    const message = event as MessageEvent<string>;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data as string);
    } catch {
      return;
    }
    const body = (payload ?? {}) as { report?: unknown; runStatus?: unknown; reason?: unknown };
    // The server closes the stream after this event; closing here means the
    // browser does not sit in a reconnect loop over a run that has finished.
    closed = true;
    source.close();
    const runStatus = typeof body.runStatus === 'string' ? body.runStatus : 'completed';
    if (body.reason === 'run_not_found') {
      handlers.onConnection('reconnecting');
      return;
    }
    handlers.onFinal(parseFinalReport(body.report), runStatus);
  });

  source.addEventListener('error', () => {
    if (closed) return;
    // EventSource retries on its own (the server sends `retry:`), so this is a
    // "waiting" signal, not a failure: the run is untouched on the server.
    handlers.onConnection('reconnecting');
  });

  return {
    close: () => {
      closed = true;
      source.close();
    },
  };
}

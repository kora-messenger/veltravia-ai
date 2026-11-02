/**
 * Chat state for the assistant surface.
 *
 * The page is a client of the reasoning engine: it sends the question, follows
 * the run the server created, and renders what came back. It never invents an
 * answer and never shows a partial as finished.
 *
 * The one thing that changed in Step 37 is what happens around the send. A
 * message now moves through a short, explicit life:
 *
 *   thinking    - the request is on its way; the server has not accepted it yet
 *   running     - the server created a run; its activity is being followed
 *   finished    - the run stopped, so the answer and the report are final
 *
 * The distinction that matters is `thinking` versus `running`. Before the server
 * accepts, a failure means nothing happened: the bubbles are removed and the text
 * goes back in the composer, so the person does not end up with a message that
 * looks sent when it was not. After the server accepts, the opposite is true: the
 * run exists, so the text stays gone and the page reconnects to the run it
 * already has. Sending it again would be the duplicate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  mergeAgentActivities,
  type AgentActivityEvent,
  type FinalAgentReport,
} from '@veltravia/shared';
import { ApiError, TransportError, errorMessage, isOffline } from '../../api/client';
import {
  cancelRun,
  getCapabilities,
  getRun,
  isTerminal,
  startRun,
  type ReasoningCapabilities,
  type ReasoningRunView,
} from '../../api/reasoning';
import { getActivitySnapshot } from '../../api/activity';
import { RunFollower, type FollowConnection } from './followRun';

export type ChatRole = 'user' | 'assistant';

export type ChatMessageState = 'pending' | 'done' | 'failed' | 'cancelled' | 'needs-approval';

/** Where a turn is in its life, independent of what the run reported. */
export type MessagePhase = 'thinking' | 'running' | 'finished';

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly state: ChatMessageState;
  readonly phase: MessagePhase;
  /** Plain-language reason, present only when `state` is not `done`. */
  readonly note?: string;
  /** The server's run, once it exists. Null while still thinking. */
  readonly runId: string | null;
  readonly activities: readonly AgentActivityEvent[];
  readonly report: FinalAgentReport | null;
  readonly runStatus: string | null;
  readonly connection: FollowConnection | null;
}

/** How a send failed, which decides what the page does next. */
export type SendFailureKind =
  'offline' | 'timeout' | 'unavailable' | 'auth' | 'rejected' | 'unknown';

export interface SendFailure {
  readonly kind: SendFailureKind;
  readonly message: string;
}

/**
 * Sorts a failed send into the states the interface distinguishes.
 *
 * The mapping is deliberately narrow: the API's own codes are trusted where they
 * exist, and anything unrecognised stays `unknown` rather than being reported as
 * something it might not be.
 */
export function classifySendFailure(error: unknown): SendFailure {
  if (error instanceof TransportError) {
    if (error.failure === 'offline') return { kind: 'offline', message: error.message };
    if (error.failure === 'timeout') return { kind: 'timeout', message: error.message };
    return { kind: 'unavailable', message: error.message };
  }
  if (error instanceof ApiError) {
    const name = error.code.toUpperCase();
    if (error.status === 401 || error.status === 403 || name.includes('FORBIDDEN')) {
      return {
        kind: 'auth',
        message: 'This agent is not authorised to run here. Sign in again and retry.',
      };
    }
    if (error.status >= 500 || name.includes('UNAVAILABLE')) {
      return { kind: 'unavailable', message: errorMessage(error) };
    }
    if (error.status >= 400) return { kind: 'rejected', message: errorMessage(error) };
  }
  if (isOffline()) {
    return { kind: 'offline', message: 'You are offline. Your message was not sent.' };
  }
  return { kind: 'unknown', message: errorMessage(error) };
}

/** What the composer shows above itself after a send did not take. */
export function failureNote(failure: SendFailure): string {
  switch (failure.kind) {
    case 'offline':
      return 'You are offline. Your message is back in the box.';
    case 'timeout':
      return 'The service did not answer in time. Your message is back in the box.';
    case 'unavailable':
      return 'The service is unavailable right now. Your message is back in the box.';
    case 'auth':
      return failure.message;
    case 'rejected':
      return failure.message;
    default:
      return 'That message could not be sent. It is back in the box.';
  }
}

/**
 * Keeps a capabilities payload only if it is the shape the page reads.
 *
 * The page asks five questions of this object, so a short or malformed reply
 * from an older or misconfigured server must not take the whole screen down: an
 * unusable answer is treated as "not known yet", which shows the simulated
 * state honestly instead of crashing.
 */
export function readCapabilities(value: unknown): ReasoningCapabilities | null {
  if (typeof value !== 'object' || value === null) return null;
  const provider = (value as { provider?: unknown }).provider;
  if (typeof provider !== 'object' || provider === null) return null;
  const connected = (provider as { connected?: unknown }).connected;
  const reason = (provider as { reason?: unknown }).reason;
  if (typeof connected !== 'boolean') return null;
  if (reason !== null && typeof reason !== 'string') return null;
  return value as ReasoningCapabilities;
}

/** Turns of context sent with each question. */
const HISTORY_TURNS = 10;
/** Long enough for a real run to be created, short enough not to hang a phone. */
const START_TIMEOUT_MS = 20_000;

let messageCounter = 0;
const nextId = (): string => {
  messageCounter += 1;
  return `m${messageCounter}`;
};

const emptyTurn = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  state: 'pending',
  phase: 'thinking',
  runId: null,
  activities: [],
  report: null,
  runStatus: null,
  connection: null,
});

/** Cancels a run without letting a transport failure disturb local state. */
function cancelQuietly(runId: string | null): void {
  if (runId === null) return;
  try {
    void Promise.resolve(cancelRun(runId)).catch(() => undefined);
  } catch {
    // The run may already have finished; nothing to undo.
  }
}

export interface UseChatResult {
  readonly messages: readonly ChatMessage[];
  readonly busy: boolean;
  readonly capabilities: ReasoningCapabilities | null;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly reset: () => void;
  readonly canRetry: boolean;
  /** Set when a send did not reach the server, with the text to put back. */
  readonly restore: { readonly text: string; readonly note: string; readonly token: number } | null;
  /** Acknowledges a restore once the composer has taken the text back. */
  readonly clearRestore: () => void;
}

export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<ReasoningCapabilities | null>(null);
  const [restore, setRestore] = useState<UseChatResult['restore']>(null);

  const follower = useRef<RunFollower | null>(null);
  const activeRun = useRef<string | null>(null);
  const mounted = useRef(true);
  const lastQuestion = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      follower.current?.stop();
    };
  }, []);

  // The provider state decides how a question is answered, so it is read once
  // rather than guessed. A failure here is not fatal: the chip simply reports
  // that it does not know yet.
  useEffect(() => {
    let live = true;
    getCapabilities()
      .then((result) => {
        if (live) setCapabilities(readCapabilities(result));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const patch = useCallback((id: string, next: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...next } : message)),
    );
  }, []);

  /** Applies a finished run to its turn: answer, note and report, all final. */
  const finish = useCallback(
    (id: string, run: { status: string; answer?: string; error?: { message: string } }) => {
      if (run.status === 'completed') {
        patch(id, {
          text: run.answer ?? '',
          state: run.answer === undefined || run.answer === '' ? 'failed' : 'done',
          phase: 'finished',
          runStatus: run.status,
          note:
            run.answer === undefined || run.answer === ''
              ? 'The run finished without an answer.'
              : undefined,
        });
        return;
      }
      if (run.status === 'awaiting_confirmation') {
        patch(id, {
          state: 'needs-approval',
          phase: 'finished',
          runStatus: run.status,
          note: 'This task wants to use a tool that needs your approval. Approve it in the reasoning workspace, then ask again here.',
        });
        return;
      }
      if (run.status === 'cancelled') {
        patch(id, {
          state: 'cancelled',
          phase: 'finished',
          runStatus: run.status,
          note: 'You stopped this answer.',
        });
        return;
      }
      patch(id, {
        state: 'failed',
        phase: 'finished',
        runStatus: run.status,
        note:
          run.error?.message ??
          (run.status === 'limit_reached'
            ? 'The run reached its step or time limit before answering.'
            : 'The run did not produce an answer.'),
      });
    },
    [patch],
  );

  /** Starts following a run the server has already accepted. */
  const follow = useCallback(
    (runId: string, messageId: string, run: ReasoningRunView) => {
      follower.current?.stop();
      const next = new RunFollower({
        runId,
        onUpdate: (update) => {
          if (!mounted.current) return;
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    phase: update.terminal ? 'finished' : 'running',
                    activities: mergeAgentActivities(message.activities, update.activities),
                    report: update.report ?? message.report,
                    runStatus: update.runStatus ?? message.runStatus,
                    connection: update.connection,
                  }
                : message,
            ),
          );
          if (update.terminal) {
            // The stream reports that the run stopped; the answer lives on the
            // run itself, so it is read once more rather than inferred from the
            // report. A read that fails still ends the turn honestly.
            const status = update.runStatus ?? run.status;
            void getRun(runId)
              .then((latest) => {
                if (mounted.current) finish(messageId, latest);
              })
              .catch(() => {
                if (mounted.current) finish(messageId, { status });
              })
              .finally(() => {
                activeRun.current = null;
                if (mounted.current) setBusy(false);
              });
          }
        },
      });
      follower.current = next;
      next.start(0);
    },
    [finish],
  );

  /**
   * Reads a run's timeline once, without following it.
   *
   * Used when the run was already over by the time the start call returned: the
   * work is worth showing, but there is nothing left to watch. A failure here
   * only costs the timeline, never the answer.
   */
  const loadTimeline = useCallback((runId: string, messageId: string) => {
    void getActivitySnapshot(runId, 0)
      .then((snapshot) => {
        if (!mounted.current || snapshot === null) return;
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  activities: mergeAgentActivities(message.activities, snapshot.activities),
                  report: snapshot.report,
                  runStatus: snapshot.runStatus,
                }
              : message,
          ),
        );
      })
      .catch(() => undefined);
  }, []);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      // One send at a time: a second tap while thinking would run the request
      // twice and produce two runs for one message.
      if (text === '' || busy) return;

      const history = messages
        .filter((message) => message.state === 'done')
        .slice(-HISTORY_TURNS * 2)
        .map((message) => ({ role: message.role, content: message.text }));

      lastQuestion.current = text;
      setRestore(null);
      const questionId = nextId();
      const answerId = nextId();
      setMessages((current) => [
        ...current,
        {
          id: questionId,
          role: 'user',
          text,
          state: 'done',
          phase: 'finished',
          runId: null,
          activities: [],
          report: null,
          runStatus: null,
          connection: null,
        },
        emptyTurn(answerId),
      ]);
      setBusy(true);

      const mode =
        capabilities === null || capabilities.provider.connected ? 'gateway' : 'simulated';

      startRun({
        task: text,
        profile: 'workspace',
        mode,
        conversation: history,
        timeoutMs: START_TIMEOUT_MS,
      })
        .then((run) => {
          if (!mounted.current) return;
          activeRun.current = run.id;
          patch(answerId, {
            runId: run.id,
            phase: 'running',
            runStatus: run.status,
            connection: 'reconnecting',
          });
          if (isTerminal(run.status) || run.status === 'awaiting_confirmation') {
            // Already over by the time it came back: the answer is in this
            // reply, and one read of the timeline is enough to show the work.
            finish(answerId, run);
            loadTimeline(run.id, answerId);
            activeRun.current = null;
            setBusy(false);
            return;
          }
          follow(run.id, answerId, run);
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          const failure = classifySendFailure(error);
          // Nothing was accepted, so nothing should look sent: both bubbles go
          // and the text returns to the composer, unedited and unsent.
          setMessages((current) =>
            current.filter((message) => message.id !== questionId && message.id !== answerId),
          );
          setBusy(false);
          setRestore({ text, note: failureNote(failure), token: Date.now() });
        });
    },
    [busy, capabilities, finish, follow, loadTimeline, messages, patch],
  );

  const stop = useCallback(() => {
    const runId = activeRun.current;
    follower.current?.stop();
    follower.current = null;
    setMessages((current) =>
      current.map((message) =>
        message.phase === 'running' || message.phase === 'thinking'
          ? {
              ...message,
              state: 'cancelled',
              phase: 'finished',
              note: 'You stopped this answer.',
            }
          : message,
      ),
    );
    setBusy(false);
    activeRun.current = null;
    cancelQuietly(runId);
  }, []);

  const retry = useCallback(() => {
    const question = lastQuestion.current;
    if (question === null) return;
    setMessages((current) => current.filter((message) => message.state !== 'failed'));
    send(question);
  }, [send]);

  const reset = useCallback(() => {
    follower.current?.stop();
    follower.current = null;
    cancelQuietly(activeRun.current);
    activeRun.current = null;
    lastQuestion.current = null;
    setMessages([]);
    setRestore(null);
    setBusy(false);
  }, []);

  const clearRestore = useCallback(() => setRestore(null), []);

  const canRetry =
    !busy && messages.some((message) => message.role === 'assistant' && message.state === 'failed');

  return {
    messages,
    busy,
    capabilities,
    send,
    stop,
    retry,
    reset,
    canRetry,
    restore,
    clearRestore,
  };
}

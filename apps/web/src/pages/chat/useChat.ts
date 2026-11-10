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
  continueRun,
  getCapabilities,
  getModelPicker,
  getRun,
  isTerminal,
  startRun,
  type AvailableModel,
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
  /** Set when the send itself failed, so the turn can say why and offer retry. */
  readonly failure?: SendFailure | null;
  /** The words that never left, kept so a retry does not need them on screen. */
  readonly failedQuestion?: string | null;
  readonly activities: readonly AgentActivityEvent[];
  readonly report: FinalAgentReport | null;
  readonly runStatus: string | null;
  readonly connection: FollowConnection | null;
  /** What budget a stopped run used, so the turn can say "5 of 5 tool calls". */
  readonly budget?: ChatBudget | null;
  /** Whether the stopped run may carry on with a fresh budget. */
  readonly canContinue?: boolean;
}

/** A budget a run spent, in the words the engine used. */
export interface ChatBudget {
  readonly kind: string;
  readonly used: number;
  readonly ceiling: number;
}

/** How a send failed, which decides what the page does next. */
export type SendFailureKind =
  'offline' | 'timeout' | 'unavailable' | 'auth' | 'rejected' | 'missing' | 'unknown';

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
    // A host that serves the bundle but is not the API answers 404, or 405
    // because a static file host refuses POST outright (GitHub Pages does). Both
    // mean the same thing: there is no backend behind this page. That is a
    // configuration fact, not a rejection of what was asked, and retrying cannot
    // change it. Veltravia's own routes never answer 404/405 for a run request.
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return {
        kind: 'missing',
        message: 'This page is not connected to a Veltravia backend.',
      };
    }
    if (error.status >= 400) return { kind: 'rejected', message: errorMessage(error) };
  }
  if (isOffline()) {
    return { kind: 'offline', message: 'You are offline. Your message was not sent.' };
  }
  return { kind: 'unknown', message: errorMessage(error) };
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
  /** Models this account can pin; empty until the list arrives. */
  readonly models: readonly AvailableModel[];
  /** Re-reads provider state and the model list, after a choice. */
  readonly refreshCapabilities: () => void;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly retry: () => void;
  /** Carries a run that stopped at its budget on with a fresh one. */
  readonly continueAnswer: () => void;
  readonly reset: () => void;
  /** Shows a stored conversation's finished turns, replacing what is on screen. */
  readonly hydrate: (messages: readonly ChatMessage[]) => void;
  readonly canRetry: boolean;
  readonly canContinue: boolean;
  /** Set when a send did not reach the server: the words to hand back. */
  readonly restore: { readonly text: string; readonly token: number } | null;
  /** Acknowledges a restore once the composer has taken the words back. */
  readonly clearRestore: () => void;
}

export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<ReasoningCapabilities | null>(null);
  // The picker's list is separate from capabilities: it is bigger and changes
  // far less often, so it is fetched once and refetched after a choice.
  const [models, setModels] = useState<readonly AvailableModel[]>([]);
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

  // The provider state decides how a question is answered, so it is read rather
  // than guessed, and again whenever a model is pinned. A failure here is not
  // fatal: the chip simply reports that it does not know yet.
  const loadCapabilities = useCallback(() => {
    getCapabilities()
      .then((result) => setCapabilities(readCapabilities(result)))
      .catch(() => undefined);
    getModelPicker()
      .then((result) => setModels(result.models))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadCapabilities();
  }, [loadCapabilities]);

  const patch = useCallback((id: string, next: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...next } : message)),
    );
  }, []);

  /** Applies a finished run to its turn: answer, note and report, all final. */
  const finish = useCallback(
    (
      id: string,
      run: {
        status: string;
        answer?: string;
        error?: { message: string };
        limit?: { kind: string; used: number; ceiling: number };
        canContinue?: boolean;
      },
    ) => {
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
      if (run.status === 'limit_reached') {
        // Stopping at a budget is not a fault: nothing broke, the work is kept,
        // and saying which ceiling was spent is the useful part.
        patch(id, {
          state: 'failed',
          phase: 'finished',
          runStatus: run.status,
          note: undefined,
          budget: run.limit
            ? { kind: run.limit.kind, used: run.limit.used, ceiling: run.limit.ceiling }
            : null,
          canContinue: run.canContinue === true,
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

  /**
   * Runs one question into one answer turn.
   *
   * The question and answer turns are excluded from the history it sends: a retry
   * reuses the same two turns, and without this the model would see the failed
   * question twice (once in the history, once as the task).
   */
  const runAnswer = useCallback(
    (text: string, questionId: string, answerId: string) => {
      const history = messages
        .filter(
          (message) =>
            message.state === 'done' && message.id !== questionId && message.id !== answerId,
        )
        .slice(-HISTORY_TURNS * 2)
        .map((message) => ({ role: message.role, content: message.text }));
      lastQuestion.current = text;
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
          // Nothing reached the server, so nothing is left looking sent: the
          // question comes off the screen and the words go back into the box,
          // exactly as typed. What stays is the warning in the answer slot, so
          // the failure is visible rather than silent.
          setMessages((current) => current.filter((message) => message.id !== questionId));
          patch(answerId, {
            state: 'failed',
            phase: 'finished',
            failure,
            failedQuestion: text,
            text: '',
          });
          setRestore({ text, token: Date.now() });
          setBusy(false);
        });
    },
    [capabilities, finish, follow, loadTimeline, messages, patch],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      // One send at a time: a second tap while thinking would run the request
      // twice and produce two runs for one message.
      if (text === '' || busy) return;
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
      runAnswer(text, questionId, answerId);
    },
    [busy, runAnswer],
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

  /**
   * Retries the last failed turn.
   *
   * A send that never left has no question on screen: the warning is standing
   * where the question would have been. Retrying therefore takes the warning
   * away and sends the words it kept, which puts one question back in the thread
   * and one answer under it. A run that failed after being accepted still has its
   * question, and that one is retried in place so it is not duplicated.
   */
  const retry = useCallback(() => {
    if (busy) return;
    const failed = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.state === 'failed');
    if (failed === undefined) return;

    const kept = failed.failedQuestion ?? null;
    if (kept !== null) {
      setMessages((current) => current.filter((message) => message.id !== failed.id));
      send(kept);
      return;
    }

    const index = messages.findIndex((message) => message.id === failed.id);
    const question = [...messages.slice(0, index)]
      .reverse()
      .find((message) => message.role === 'user');
    if (question === undefined) return;
    patch(failed.id, { ...emptyTurn(failed.id) });
    runAnswer(question.text, question.id, failed.id);
  }, [busy, messages, patch, runAnswer, send]);

  /**
   * Carries a stopped run on with a fresh budget.
   *
   * It resumes the same run, so the steps it already took are kept and the model
   * picks up where it stopped instead of starting the task again.
   */
  const continueAnswer = useCallback(() => {
    if (busy) return;
    const stopped = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.runStatus === 'limit_reached' &&
          message.canContinue === true &&
          message.runId !== null,
      );
    if (stopped?.runId == null) return;

    const runId = stopped.runId;
    patch(stopped.id, {
      state: 'pending',
      phase: 'thinking',
      note: undefined,
      budget: null,
      canContinue: false,
    });
    setBusy(true);
    activeRun.current = runId;
    void continueRun(runId)
      .then((run) => {
        if (!mounted.current) return;
        follow(runId, stopped.id, run);
      })
      .catch(() => {
        if (!mounted.current) return;
        patch(stopped.id, {
          state: 'failed',
          phase: 'finished',
          note: 'The run could not carry on. Send the message again to start fresh.',
        });
      })
      .finally(() => {
        if (activeRun.current === runId) activeRun.current = null;
        if (mounted.current) setBusy(false);
      });
  }, [busy, follow, messages, patch]);

  const clearRestore = useCallback(() => setRestore(null), []);

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

  // Reopening a stored conversation: the same clean slate as a new chat, with
  // the saved turns already in it and nothing running.
  const hydrate = useCallback((next: readonly ChatMessage[]) => {
    follower.current?.stop();
    follower.current = null;
    cancelQuietly(activeRun.current);
    activeRun.current = null;
    lastQuestion.current = null;
    setMessages(next);
    setRestore(null);
    setBusy(false);
  }, []);

  const canContinueRun =
    !busy &&
    messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.runStatus === 'limit_reached' &&
        message.canContinue === true,
    );

  const canRetry =
    !busy && messages.some((message) => message.role === 'assistant' && message.state === 'failed');

  return {
    messages,
    busy,
    capabilities,
    models,
    refreshCapabilities: loadCapabilities,
    send,
    stop,
    retry,
    continueAnswer,
    canContinue: canContinueRun,
    reset,
    hydrate,
    canRetry,
    restore,
    clearRestore,
  };
}

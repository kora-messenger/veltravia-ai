/**
 * Chat state for the assistant landing page.
 *
 * The page is a presentation client for the reasoning engine: it sends the
 * question, follows the run the server reports, and renders exactly what came
 * back. It never invents an answer, never shows a partial as finished, and a
 * failed run stays failed until the person asks again.
 *
 * Runs are followed by polling `GET /runs/:id` rather than SSE: one code path
 * that behaves the same in every browser, and no half-rendered stream to clean
 * up when a connection drops.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import {
  cancelRun,
  getCapabilities,
  getRun,
  isTerminal,
  startRun,
  type ReasoningCapabilities,
  type ReasoningRunView,
} from '../../api/reasoning';

export type ChatRole = 'user' | 'assistant';

export type ChatMessageState = 'pending' | 'done' | 'failed' | 'cancelled' | 'needs-approval';

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly state: ChatMessageState;
  /** Plain-language reason, present only when `state` is not `done`. */
  readonly note?: string;
}

const POLL_MS = 900;
/** Roughly six minutes of polling before the page stops following a run. */
const MAX_POLLS = 400;
/** Turns of context sent with each question. */
const HISTORY_TURNS = 10;

/** Cancels a run without letting a transport failure disturb local state. */
function cancelQuietly(runId: string | null): void {
  if (runId === null) return;
  try {
    void Promise.resolve(cancelRun(runId)).catch(() => undefined);
  } catch {
    // The run may already have finished; nothing to undo.
  }
}

let messageCounter = 0;
const nextId = (): string => {
  messageCounter += 1;
  return `m${messageCounter}`;
};

export interface UseChatResult {
  readonly messages: readonly ChatMessage[];
  readonly busy: boolean;
  readonly capabilities: ReasoningCapabilities | null;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly reset: () => void;
  readonly canRetry: boolean;
}

export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<ReasoningCapabilities | null>(null);

  const activeRun = useRef<string | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const lastQuestion = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The provider state decides how a question is answered, so it is read once
  // rather than guessed. A failure here is not fatal: the chip simply reports
  // that it does not know yet.
  useEffect(() => {
    let live = true;
    getCapabilities()
      .then((result) => {
        if (live) setCapabilities(result);
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

  const finish = useCallback(
    (id: string, run: ReasoningRunView) => {
      if (run.status === 'completed') {
        patch(id, {
          text: run.answer ?? '',
          state: run.answer === undefined || run.answer === '' ? 'failed' : 'done',
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
          note: 'This task wants to use a tool that needs your approval. Approve it in the reasoning workspace, then ask again here.',
        });
        return;
      }
      if (run.status === 'cancelled') {
        patch(id, { state: 'cancelled', note: 'You stopped this answer.' });
        return;
      }
      patch(id, {
        state: 'failed',
        note:
          run.error?.message ??
          (run.status === 'limit_reached'
            ? 'The run reached its step or time limit before answering.'
            : 'The run did not produce an answer.'),
      });
    },
    [patch],
  );

  const follow = useCallback(
    async (runId: string, messageId: string) => {
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!mounted.current || cancelled.current) return;
        let run: ReasoningRunView;
        try {
          run = await getRun(runId);
        } catch (error) {
          if (!mounted.current) return;
          patch(messageId, {
            state: 'failed',
            note: `The run could not be followed any more. ${errorMessage(error)}`,
          });
          return;
        }
        if (isTerminal(run.status) || run.status === 'awaiting_confirmation') {
          if (mounted.current) finish(messageId, run);
          return;
        }
      }
      if (mounted.current) {
        patch(messageId, {
          state: 'failed',
          note: 'Stopped waiting for this run. It may still be running on the server.',
        });
      }
    },
    [finish, patch],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text === '' || busy) return;

      const history = messages
        .filter((message) => message.state === 'done')
        .slice(-HISTORY_TURNS * 2)
        .map((message) => ({ role: message.role, content: message.text }));

      lastQuestion.current = text;
      cancelled.current = false;
      const questionId = nextId();
      const answerId = nextId();
      setMessages((current) => [
        ...current,
        { id: questionId, role: 'user', text, state: 'done' },
        { id: answerId, role: 'assistant', text: '', state: 'pending' },
      ]);
      setBusy(true);

      const mode =
        capabilities === null || capabilities.provider.connected ? 'gateway' : 'simulated';

      startRun({ task: text, profile: 'workspace', mode, conversation: history })
        .then((run) => {
          if (!mounted.current) return;
          activeRun.current = run.id;
          if (isTerminal(run.status) || run.status === 'awaiting_confirmation') {
            finish(answerId, run);
            setBusy(false);
            return;
          }
          void follow(run.id, answerId).finally(() => {
            activeRun.current = null;
            if (mounted.current) setBusy(false);
          });
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          patch(answerId, {
            state: 'failed',
            note: `${errorMessage(error)}`,
          });
          setBusy(false);
        });
    },
    [busy, capabilities, finish, follow, messages, patch],
  );

  const stop = useCallback(() => {
    cancelled.current = true;
    const runId = activeRun.current;
    setMessages((current) =>
      current.map((message) =>
        message.state === 'pending'
          ? { ...message, state: 'cancelled', note: 'You stopped this answer.' }
          : message,
      ),
    );
    setBusy(false);
    cancelQuietly(runId);
  }, []);

  const retry = useCallback(() => {
    const question = lastQuestion.current;
    if (question === null) return;
    setMessages((current) => current.filter((message) => message.state !== 'failed'));
    send(question);
  }, [send]);

  const reset = useCallback(() => {
    cancelled.current = true;
    cancelQuietly(activeRun.current);
    activeRun.current = null;
    lastQuestion.current = null;
    setMessages([]);
    setBusy(false);
  }, []);

  const canRetry =
    !busy && messages.some((message) => message.role === 'assistant' && message.state === 'failed');

  return { messages, busy, capabilities, send, stop, retry, reset, canRetry };
}

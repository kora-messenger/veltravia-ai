import { useToast } from '../../components/ui';
import { setChatModel, type AvailableModel, type ChatModelChoice } from '../../api/reasoning';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat, type ChatMessage } from './useChat';
import {
  CONVERSATIONS_CHANGED_EVENT,
  OPEN_CONVERSATION_EVENT,
  createConversation,
  readConversation,
  readConversations,
  saveTurns,
  type ConversationRecord,
  type StoredTurn,
} from './conversations';

/** Fired by the app surface's new-conversation control, which lives in chrome. */
export const NEW_CHAT_EVENT = 'veltravia:new-chat';

export interface ChatSession {
  readonly chat: ReturnType<typeof useChat>;
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly send: (text?: string) => void;
  /** Sends the words of the last failed turn again, from the warning on screen. */
  readonly retry: () => void;
  readonly newChat: () => void;
  readonly providerLabel: string;
  /** The pinned model, or null on Automatic. */
  readonly model: ChatModelChoice | null;
  readonly models: readonly AvailableModel[];
  /** Pins a model, or null to return to Automatic. */
  readonly chooseModel: (choice: null | AvailableModel) => void;
  readonly providerDetail: string;
  /** A conversation with no turns asks an open question; a thread asks for a message. */
  readonly placeholder: string;
  readonly started: boolean;
  /** The conversations this browser has kept, newest first. */
  readonly conversations: readonly ConversationRecord[];
  /** The stored conversation on screen, or null for a thread not saved yet. */
  readonly activeConversationId: string | null;
}

/**
 * The turns worth keeping: finished ones, in order. A turn still in flight or
 * one that failed is not part of what a person can reopen.
 */
function finishedTurns(messages: readonly ChatMessage[]): readonly StoredTurn[] {
  return messages
    .filter((message) => message.state === 'done' && message.text.trim() !== '')
    .map((message) => ({ id: message.id, role: message.role, text: message.text }));
}

/** A stored turn, as the thread shows it: nothing running, nothing to follow. */
function asMessages(turns: readonly StoredTurn[]): readonly ChatMessage[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text,
    state: 'done',
    phase: 'finished',
    runId: null,
    activities: [],
    report: null,
    runStatus: null,
    connection: null,
  }));
}

/** What a saved thread looks like, so identical work is not written twice. */
function signatureOf(turns: readonly StoredTurn[]): string {
  return turns.map((turn) => `${turn.id}:${turn.text.length}`).join('|');
}

/**
 * The state a chat surface needs, in one place, so the website layout and the
 * packaged-app layout cannot drift apart: same engine, same provider wording,
 * same placeholder rules. Only the presentation differs between them.
 */
export function useChatSession(): ChatSession {
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const appliedRestore = useRef<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<readonly ConversationRecord[]>(() =>
    readConversations(),
  );
  const lastSaved = useRef<string>('');

  // The list itself lives in storage; this keeps the open screen in step with it
  // after a rename, an archive or a delete from the drawer.
  useEffect(() => {
    const refresh = () => setConversations(readConversations());
    refresh();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
  }, []);

  // Keep the thread on screen saved as it goes: the first question names the
  // conversation, every later finished turn is appended to the same one.
  useEffect(() => {
    const turns = finishedTurns(chat.messages);
    if (turns.length === 0) return;
    const first = turns[0];
    if (first === undefined) return;
    const signature = signatureOf(turns);
    if (signature === lastSaved.current) return;
    lastSaved.current = signature;
    if (activeId === null || readConversation(activeId) === null) {
      // Either nothing was saved yet, or the thread on screen was deleted from
      // the drawer while it was open. Either way it becomes its own conversation
      // again rather than writing into a record that is gone.
      setActiveId(createConversation({ title: first.text, turns }).id);
      return;
    }
    saveTurns(activeId, turns);
  }, [chat.messages, activeId]);

  // A conversation chosen in the drawer is handed to this surface, which is the
  // only place that knows how to show it.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== 'string') return;
      const record = readConversation(id);
      if (record === null) return;
      lastSaved.current = signatureOf(record.turns);
      setActiveId(record.id);
      setDraft('');
      chat.hydrate(asMessages(record.turns));
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen);
  }, [chat.hydrate]);

  // A send that never reached the server hands its words back here, verbatim and
  // untouched: the person keeps exactly what they typed, ready to edit or send
  // again. Nothing is appended to what was already in the box.
  useEffect(() => {
    const restore = chat.restore;
    if (restore === null || appliedRestore.current === restore.token) return;
    appliedRestore.current = restore.token;
    setDraft(restore.text);
    chat.clearRestore();
  }, [chat, chat.restore]);

  const newChat = useCallback(() => {
    chat.reset();
    setDraft('');
    lastSaved.current = '';
    setActiveId(null);
  }, [chat]);

  // The packaged app's new-conversation control sits in its own header row,
  // outside this component's tree, so it announces itself instead of being
  // passed down through three layers.
  useEffect(() => {
    const onNewChat = () => newChat();
    window.addEventListener(NEW_CHAT_EVENT, onNewChat);
    return () => window.removeEventListener(NEW_CHAT_EVENT, onNewChat);
  }, [newChat]);

  const send = (text?: string) => {
    // The composer passes the words when it has attached notes to them; the
    // surface sends what is in the box otherwise.
    const body = (text ?? draft).trim();
    if (body === '' || chat.busy) return;
    chat.send(body);
    setDraft('');
  };

  // Retry sends the words the warning is holding, so the box must not keep a
  // second live copy of them.
  const retry = useCallback(() => {
    // Mark any hand-back as already applied before clearing. A restore that is
    // still queued from the failed render must not land after the retry and
    // put a second live copy of the words in the box.
    const restore = chat.restore;
    if (restore !== null) {
      appliedRestore.current = restore.token;
      chat.clearRestore();
    }
    setDraft('');
    chat.retry();
  }, [chat]);

  const providerConnected = chat.capabilities?.provider.connected ?? false;
  // The chip says what will answer: the pinned model when there is one, Auto
  // when the router decides, Simulated when nothing is connected.
  const model = chat.capabilities?.model ?? null;
  const providerLabel = providerConnected ? (model?.label ?? 'Auto') : 'Simulated';
  const providerReason = chat.capabilities?.provider.reason ?? null;
  const providerDetail = providerConnected
    ? 'Your connected provider answers, chosen automatically. Open model settings to change it.'
    : (providerReason ??
      'No provider is connected, so answers are simulated. Connect one under AI providers.');

  const started = chat.messages.length > 0;

  const { toast } = useToast();
  const chooseModel = (choice: null | AvailableModel) => {
    void setChatModel(
      choice === null ? null : { connectionId: choice.connectionId, modelId: choice.modelId },
    )
      .then(() => {
        chat.refreshCapabilities();
        // Said only once the server has stored it, so the chip and the words agree.
        toast('Chat model updated', { tone: 'success', duration: 3500 });
      })
      .catch(() => {
        toast('Could not change the chat model. Your previous choice is still in use.', {
          tone: 'error',
        });
      });
  };

  return {
    chat,
    draft,
    setDraft,
    send,
    retry,
    newChat,
    providerLabel,
    model,
    models: chat.models,
    chooseModel,
    providerDetail,
    placeholder: started ? 'Type a message…' : "What's on your mind",
    started,
    conversations,
    activeConversationId: activeId,
  };
}

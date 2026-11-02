import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from './useChat';

/** Fired by the app surface's new-conversation control, which lives in chrome. */
export const NEW_CHAT_EVENT = 'veltravia:new-chat';

export interface ChatSession {
  readonly chat: ReturnType<typeof useChat>;
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly send: () => void;
  readonly newChat: () => void;
  readonly providerLabel: string;
  readonly providerDetail: string;
  /** A conversation with no turns asks an open question; a thread asks for a message. */
  readonly placeholder: string;
  readonly started: boolean;
  /** Plain-language reason the last send did not leave, shown above the composer. */
  readonly sendError: string | null;
  readonly dismissSendError: () => void;
}

/**
 * The state a chat surface needs, in one place, so the website layout and the
 * packaged-app layout cannot drift apart: same engine, same provider wording,
 * same placeholder rules. Only the presentation differs between them.
 */
export function useChatSession(): ChatSession {
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const appliedRestore = useRef<number | null>(null);

  // A send that never reached the server leaves its text here. The composer is
  // handed it back verbatim - not re-typed by the page, not appended to whatever
  // was already in the box - so the message the person wrote is the message they
  // can edit and send again.
  useEffect(() => {
    const restore = chat.restore;
    if (restore === null || appliedRestore.current === restore.token) return;
    appliedRestore.current = restore.token;
    setDraft(restore.text);
    setSendError(restore.note);
    chat.clearRestore();
  }, [chat, chat.restore]);

  const newChat = useCallback(() => {
    chat.reset();
    setDraft('');
    setSendError(null);
  }, [chat]);

  const dismissSendError = useCallback(() => setSendError(null), []);

  // The packaged app's new-conversation control sits in its own header row,
  // outside this component's tree, so it announces itself instead of being
  // passed down through three layers.
  useEffect(() => {
    const onNewChat = () => newChat();
    window.addEventListener(NEW_CHAT_EVENT, onNewChat);
    return () => window.removeEventListener(NEW_CHAT_EVENT, onNewChat);
  }, [newChat]);

  const send = () => {
    if (draft.trim() === '' || chat.busy) return;
    chat.send(draft);
    setDraft('');
  };

  const providerConnected = chat.capabilities?.provider.connected ?? false;
  const providerLabel = providerConnected ? 'Auto' : 'Simulated';
  const providerReason = chat.capabilities?.provider.reason ?? null;
  const providerDetail = providerConnected
    ? 'Your connected provider answers, chosen automatically. Open model settings to change it.'
    : (providerReason ??
      'No provider is connected, so answers are simulated. Connect one under AI providers.');

  const started = chat.messages.length > 0;

  return {
    chat,
    draft,
    setDraft,
    send,
    newChat,
    providerLabel,
    providerDetail,
    placeholder: started ? 'Type a message…' : "What's on your mind",
    started,
    sendError,
    dismissSendError,
  };
}

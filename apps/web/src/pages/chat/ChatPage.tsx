import { useState } from 'react';
import { BrandMark } from '../../components/brand/BrandMark';
import { useAgentProfile } from '../../agent/AgentProfileProvider';
import { Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { ChatComposer } from './ChatComposer';
import { CloseIcon, PhoneIcon, TargetIcon } from './chatIcons';
import { useChat, type ChatMessage } from './useChat';

const DISMISSED_KEY = 'veltravia.chat.dismissed-suggestions';

interface Suggestion {
  readonly id: string;
  readonly icon: 'project' | 'documents';
  readonly title: string;
  readonly actionLabel: string;
  readonly hash: string;
}

/**
 * Suggestions are real destinations, not illustrations: each one goes where it
 * says it goes. The phone suggestion from the reference is deliberately absent
 * because this build has no calling channel to connect to.
 */
const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'builder',
    icon: 'project',
    title: 'Start something new from an empty project',
    actionLabel: 'Open the app builder',
    hash: '#/builder',
  },
  {
    id: 'documents',
    icon: 'documents',
    title: 'Ask questions about your own documents',
    actionLabel: 'Open document intelligence',
    hash: '#/documents',
  },
];

function readDismissed(): readonly string[] {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function Note({ message }: { readonly message: ChatMessage }) {
  if (message.note === undefined) return null;
  if (message.state === 'needs-approval') {
    return (
      <p className="v-chat__note">
        {message.note}{' '}
        <button
          type="button"
          className="v-chat__link"
          onClick={() => navigateToHash('#/reasoning')}
        >
          Open the reasoning workspace
        </button>
      </p>
    );
  }
  return <p className="v-chat__note">{message.note}</p>;
}

function Message({ message }: { readonly message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="v-chat__turn v-chat__turn--user">
        <div className="v-chat__bubble">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="v-chat__turn v-chat__turn--assistant">
      <div className="v-chat__avatar">
        <BrandMark size={24} decorative />
      </div>
      <div className="v-chat__answer">
        {message.state === 'pending' ? (
          <p className="v-chat__thinking">
            <Spinner size="sm" aria-label="Waiting for an answer" />
            <span>Working on it</span>
          </p>
        ) : (
          message.text !== '' && <p className="v-chat__text">{message.text}</p>
        )}
        <Note message={message} />
      </div>
    </div>
  );
}

/**
 * The assistant landing page: greeting, honest suggestions, and a composer
 * pinned to the bottom. Questions go to the reasoning engine and the answer
 * shown is the one the server returned.
 */
export function ChatPage() {
  const chat = useChat();
  const profile = useAgentProfile();
  const [draft, setDraft] = useState('');
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissed);
  // The name comes from the profile the owner set, not a storage key nothing
  // ever wrote. Null means they have not told us a name, so no name is invented.
  const name = profile.ownerName;

  const visible = SUGGESTIONS.filter((suggestion) => !dismissed.includes(suggestion.id));

  const dismiss = (id: string) => {
    setDismissed((current) => {
      const next = [...current, id];
      try {
        window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // A blocked storage API only costs the memory of the dismissal.
      }
      return next;
    });
  };

  const send = () => {
    if (draft.trim() === '' || chat.busy) return;
    chat.send(draft);
    setDraft('');
  };

  const newChat = () => {
    chat.reset();
    setDraft('');
  };

  const providerConnected = chat.capabilities?.provider.connected ?? false;
  const providerLabel = providerConnected ? 'Auto' : 'Simulated';
  // The server explains why no provider can be used; quoting it is more useful
  // than a generic sentence, and it is a fact rather than a guess.
  const providerReason = chat.capabilities?.provider.reason ?? null;
  const providerDetail = providerConnected
    ? 'Your connected provider answers, chosen automatically. Open model settings to change it.'
    : (providerReason ??
      'No provider is connected, so answers are simulated. Connect one under AI providers.');

  const started = chat.messages.length > 0;

  return (
    <div className="v-chat">
      <div className="v-chat__scroll">
        {!started ? (
          <div className="v-chat__hero">
            <BrandMark size={56} decorative />
            <h1 className="v-chat__greeting">
              {name === null ? 'Hey there,' : `Hey ${name},`}
              <span className="v-chat__greeting-line">what should we build?</span>
            </h1>
            {visible.length > 0 && (
              <ul className="v-chat__suggestions">
                {visible.map((suggestion) => (
                  <li className="v-chat__suggestion" key={suggestion.id}>
                    <span className="v-chat__suggestion-icon" aria-hidden="true">
                      {suggestion.icon === 'project' ? <TargetIcon /> : <PhoneIcon />}
                    </span>
                    <span className="v-chat__suggestion-body">
                      <span className="v-chat__suggestion-title">{suggestion.title}</span>
                      <button
                        type="button"
                        className="v-chat__link"
                        onClick={() => navigateToHash(suggestion.hash)}
                      >
                        {suggestion.actionLabel}
                      </button>
                    </span>
                    <button
                      type="button"
                      className="v-chat__dismiss"
                      aria-label={`Dismiss suggestion: ${suggestion.title}`}
                      onClick={() => dismiss(suggestion.id)}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="v-chat__thread">
            <div className="v-chat__thread-head">
              <h1 className="v-chat__thread-title">{profile.agentName}</h1>
              <button type="button" className="v-chat__link" onClick={newChat}>
                Start a new conversation
              </button>
            </div>
            <div className="v-chat__turns" role="log" aria-live="polite" aria-relevant="additions">
              {chat.messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
            </div>
            {chat.canRetry && (
              <button type="button" className="v-chat__retry" onClick={chat.retry}>
                Ask again
              </button>
            )}
          </div>
        )}
      </div>

      <div className="v-chat__footer">
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={chat.stop}
          onNewChat={newChat}
          busy={chat.busy}
          placeholder={
            // A conversation with nothing in it is a new conversation, so the
            // box asks an open question; once there are turns it asks for a
            // message instead.
            chat.messages.length === 0 ? "What's on your mind" : 'Type a message…'
          }
          providerLabel={providerLabel}
          providerDetail={providerDetail}
        />
        <p className="v-chat__disclaimer">
          Answers can be wrong. Check anything important before you rely on it.
        </p>
      </div>
    </div>
  );
}

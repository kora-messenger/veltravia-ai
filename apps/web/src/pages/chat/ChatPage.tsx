import { useEffect, useRef, useState } from 'react';
import { useAgentProfile } from '../../agent/AgentProfileProvider';
import { isPackagedApp } from '../../config/runtime-config';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { LiveEdgeButton } from './LiveEdgeButton';
import { MobileLanding } from './MobileLanding';
import { SuggestionList } from './SuggestionList';
import { WebLanding } from './WebLanding';
import { SUGGESTIONS } from './suggestions';
import { useChatSession } from './useChatSession';

const DISMISSED_KEY = 'veltravia.chat.dismissed-suggestions';

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

/**
 * The assistant surface.
 *
 * The website and the packaged app are two deliberate layouts over one engine:
 * the browser gets the wide landing with a centred mark, the phone app gets the
 * phone arrangement with a floating type box. Both offer the same two ways in,
 * drawn by one shared list so they cannot drift apart. Which one is
 * shown depends on where the bundle is running (`isPackagedApp`), not on the
 * window width, so a narrow browser window does not quietly become "the app".
 */
export function ChatPage() {
  const session = useChatSession();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  // The same fact as followBottom, but as state, so the way back can render.
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  /**
   * Follows new activity only while the person is already at the bottom.
   *
   * A timeline that grows under someone reading an earlier step is the worst
   * kind of live: it moves the paragraph they are on. So the page tracks whether
   * they were at the bottom before the update and only scrolls when they were.
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const atBottom = distance < 80;
      followBottom.current = atBottom;
      setAwayFromBottom(!atBottom);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || !followBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.chat.messages]);
  const returnToLive = () => {
    const node = scrollRef.current;
    if (node === null) return;
    followBottom.current = true;
    setAwayFromBottom(false);
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  };
  const profile = useAgentProfile();
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissed);
  // Bumped whenever a quick prompt is written into the box, so the box can take
  // focus without the page reaching into the composer's DOM.
  const [promptToken, setPromptToken] = useState(0);
  const app = isPackagedApp();

  // The name comes from the profile the owner set, not a storage key nothing
  // ever wrote. Null means they have not told us a name, so no name is invented.
  const name = profile.ownerName;
  const visible = SUGGESTIONS.filter((suggestion) => !dismissed.includes(suggestion.id));

  /** Writes a suggestion's words into the type box. Nothing is sent. */
  const fillPrompt = (prompt: string) => {
    session.setDraft(prompt);
    setPromptToken((current) => current + 1);
  };

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

  return (
    <div className={app ? 'v-chat v-chat--app' : 'v-chat v-chat--web'}>
      <div className="v-chat__scroll" ref={scrollRef}>
        {session.started ? (
          <ChatThread
            messages={session.chat.messages}
            ownerName={name}
            canRetry={session.chat.canRetry}
            onRetry={session.retry}
            onContinue={session.chat.continueAnswer}
          />
        ) : app ? (
          <MobileLanding
            suggestions={visible}
            onDismiss={dismiss}
            onPrompt={fillPrompt}
            onNewChat={session.newChat}
          />
        ) : (
          <WebLanding name={name} />
        )}
      </div>

      <div className="v-chat__footer">
        <LiveEdgeButton
          working={session.chat.busy}
          awayFromBottom={awayFromBottom}
          onReturn={returnToLive}
        />
        {/* The website keeps its two ways in against the type box, as the
            reference does: two stacked lines (icon, sentence, coloured action,
            close) directly above the box. They belong to the footer, so when the
            keyboard resizes the page they travel up with the box instead of
            being covered. The packaged app draws them in its own landing
            (MobileLanding), so they are not repeated there. */}
        {app || visible.length === 0 ? null : (
          <div className="v-chat__tips">
            <SuggestionList suggestions={visible} onDismiss={dismiss} onPrompt={fillPrompt} />
          </div>
        )}
        <ChatComposer
          value={session.draft}
          onChange={session.setDraft}
          onSend={session.send}
          onStop={session.chat.stop}
          busy={session.chat.busy}
          placeholder={session.placeholder}
          providerLabel={session.providerLabel}
          providerDetail={session.providerDetail}
          model={session.model}
          models={session.models}
          chooseModel={session.chooseModel}
          focusToken={promptToken}
        />
      </div>
    </div>
  );
}

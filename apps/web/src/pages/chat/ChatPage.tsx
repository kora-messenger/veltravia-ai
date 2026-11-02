import { useState } from 'react';
import { useAgentProfile } from '../../agent/AgentProfileProvider';
import { isPackagedApp } from '../../config/runtime-config';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { MobileLanding } from './MobileLanding';
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
  const profile = useAgentProfile();
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissed);
  const app = isPackagedApp();

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

  return (
    <div className={app ? 'v-chat v-chat--app' : 'v-chat v-chat--web'}>
      <div className="v-chat__scroll">
        {session.started ? (
          <ChatThread
            messages={session.chat.messages}
            agentName={profile.agentName}
            ownerName={name}
            canRetry={session.chat.canRetry}
            onRetry={session.chat.retry}
            onNewChat={session.newChat}
          />
        ) : app ? (
          <MobileLanding suggestions={visible} onDismiss={dismiss} onNewChat={session.newChat} />
        ) : (
          <WebLanding name={name} suggestions={visible} onDismiss={dismiss} />
        )}
      </div>

      <div className="v-chat__footer">
        <ChatComposer
          value={session.draft}
          onChange={session.setDraft}
          onSend={session.send}
          onStop={session.chat.stop}
          onNewChat={session.newChat}
          busy={session.chat.busy}
          placeholder={session.placeholder}
          providerLabel={session.providerLabel}
          providerDetail={session.providerDetail}
        />
      </div>
    </div>
  );
}

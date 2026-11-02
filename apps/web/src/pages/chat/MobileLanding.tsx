import { NewChatIcon } from './chatIcons';
import { SuggestionList } from './SuggestionList';
import type { Suggestion } from './suggestions';

export interface MobileLandingProps {
  readonly suggestions: readonly Suggestion[];
  readonly onDismiss: (id: string) => void;
  readonly onNewChat: () => void;
}

/**
 * The packaged app's empty state: no hero mark competing for a small screen, the
 * two ways in as the same small lines the website uses, above the type box, with
 * the whitespace above them left empty on purpose.
 *
 * The menu control is the shell's (top-left); this row supplies the other
 * circle the reference has, which starts a fresh conversation.
 */
export function MobileLanding({ suggestions, onDismiss, onNewChat }: MobileLandingProps) {
  return (
    <div className="v-chat__app">
      <div className="v-chat__appbar">
        <button
          type="button"
          className="v-chat__round"
          aria-label="Start a new conversation"
          onClick={onNewChat}
        >
          <NewChatIcon />
        </button>
      </div>

      <div className="v-chat__app-spacer" />

      {suggestions.length > 0 && <SuggestionList suggestions={suggestions} onDismiss={onDismiss} />}
    </div>
  );
}

import { navigateToHash } from '../../shell/useHashRoute';
import { NewChatIcon } from './chatIcons';
import type { Suggestion } from './suggestions';

export interface MobileLandingProps {
  readonly suggestions: readonly Suggestion[];
  readonly onNewChat: () => void;
}

/**
 * The packaged app's empty state: no hero mark competing for a small screen,
 * the two ways in as plain lines above the type box, and the whitespace above
 * them left empty on purpose.
 *
 * The menu control is the shell's (top-left); this row supplies the other
 * circle the reference has, which starts a fresh conversation.
 */
export function MobileLanding({ suggestions, onNewChat }: MobileLandingProps) {
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

      {suggestions.length > 0 && (
        <ul className="v-chat__prompts">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                className="v-chat__prompt"
                onClick={() => navigateToHash(suggestion.hash)}
              >
                {suggestion.short}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

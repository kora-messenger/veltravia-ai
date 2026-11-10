import { navigateToHash } from '../../shell/useHashRoute';
import { CloseIcon, DocumentIcon, MailIcon, PencilIcon } from './chatIcons';
import type { Suggestion } from './suggestions';

export interface SuggestionListProps {
  readonly suggestions: readonly Suggestion[];
  readonly onDismiss: (id: string) => void;
  /** Writes a suggestion's words into the type box, without sending them. */
  readonly onPrompt: (prompt: string) => void;
}

function SuggestionIcon({ suggestion }: { readonly suggestion: Suggestion }) {
  if (suggestion.icon === 'mail') return <MailIcon />;
  if (suggestion.icon === 'pencil') return <PencilIcon />;
  return <DocumentIcon />;
}

/**
 * The ways in, as the packaged app draws them: one small line each, a thin icon
 * on the left, the sentence in the muted colour, the destination in the brand
 * colour, and a close control at the far right. No card, no fill, no border.
 *
 * A line either navigates or writes its prompt into the type box; which one is
 * a property of the suggestion, so neither layout can invent a third behaviour.
 */
export function SuggestionList({ suggestions, onDismiss, onPrompt }: SuggestionListProps) {
  return (
    <ul className="v-chat__suggestions">
      {suggestions.map((suggestion) => (
        <li className="v-chat__suggestion" key={suggestion.id}>
          <span className="v-chat__suggestion-icon" aria-hidden="true">
            <SuggestionIcon suggestion={suggestion} />
          </span>
          <p className="v-chat__suggestion-text">
            {suggestion.title}{' '}
            <button
              type="button"
              className="v-chat__suggestion-action"
              onClick={() => {
                if (suggestion.kind === 'link') navigateToHash(suggestion.hash);
                else onPrompt(suggestion.prompt);
              }}
            >
              {suggestion.actionLabel}
            </button>
          </p>
          <button
            type="button"
            className="v-chat__dismiss"
            aria-label={`Dismiss suggestion: ${suggestion.title}`}
            onClick={() => onDismiss(suggestion.id)}
          >
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

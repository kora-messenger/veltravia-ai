import { navigateToHash } from '../../shell/useHashRoute';
import { CloseIcon, DocumentIcon, PencilIcon } from './chatIcons';
import type { Suggestion } from './suggestions';

export interface SuggestionListProps {
  readonly suggestions: readonly Suggestion[];
  readonly onDismiss: (id: string) => void;
}

/**
 * The ways in, as the reference draws them: one small line each, a thin icon on
 * the left, the sentence in the muted colour, the destination in the brand
 * colour, and a close control at the far right. No card, no fill, no border.
 *
 * Both layouts use this: the website under its greeting, the phone app above the
 * type box, so the two can never drift apart.
 */
export function SuggestionList({ suggestions, onDismiss }: SuggestionListProps) {
  return (
    <ul className="v-chat__suggestions">
      {suggestions.map((suggestion) => (
        <li className="v-chat__suggestion" key={suggestion.id}>
          <span className="v-chat__suggestion-icon" aria-hidden="true">
            {suggestion.icon === 'pencil' ? <PencilIcon /> : <DocumentIcon />}
          </span>
          <p className="v-chat__suggestion-text">
            {suggestion.title}{' '}
            <button
              type="button"
              className="v-chat__suggestion-action"
              onClick={() => navigateToHash(suggestion.hash)}
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

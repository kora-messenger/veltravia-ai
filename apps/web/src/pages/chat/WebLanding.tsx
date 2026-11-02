import { BrandMark } from '../../components/brand/BrandMark';
import { navigateToHash } from '../../shell/useHashRoute';
import { CloseIcon, DocumentIcon, PencilIcon } from './chatIcons';
import type { Suggestion } from './suggestions';

export interface WebLandingProps {
  readonly name: string | null;
  readonly suggestions: readonly Suggestion[];
  readonly onDismiss: (id: string) => void;
}

/**
 * The website's empty state: the mark, a greeting, and two cards that each go
 * somewhere real. The card carries its action on the right, the way the
 * reference does, and can be dismissed for the session.
 */
export function WebLanding({ name, suggestions, onDismiss }: WebLandingProps) {
  return (
    <div className="v-chat__hero">
      <BrandMark size={56} decorative />
      <h1 className="v-chat__greeting">
        {name === null ? 'Hey there,' : `Hey ${name},`}
        <span className="v-chat__greeting-line">what should we build?</span>
      </h1>
      {suggestions.length > 0 && (
        <ul className="v-chat__suggestions">
          {suggestions.map((suggestion) => (
            <li className="v-chat__suggestion" key={suggestion.id}>
              <span className="v-chat__suggestion-icon" aria-hidden="true">
                {suggestion.icon === 'pencil' ? <PencilIcon /> : <DocumentIcon />}
              </span>
              <span className="v-chat__suggestion-title">{suggestion.title}</span>
              <button
                type="button"
                className="v-chat__link v-chat__suggestion-action"
                onClick={() => navigateToHash(suggestion.hash)}
              >
                {suggestion.actionLabel}
              </button>
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
      )}
    </div>
  );
}

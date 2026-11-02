import { BrandMark } from '../../components/brand/BrandMark';
import { navigateToHash } from '../../shell/useHashRoute';
import type { Suggestion } from './suggestions';

export interface WebLandingProps {
  readonly name: string | null;
  readonly suggestions: readonly Suggestion[];
}

/**
 * The website's empty state: the mark, a greeting, and two ways in.
 *
 * The ways in are plain lines of text that go somewhere real. No box, no icon,
 * no close control: an empty conversation should read as an invitation, not as
 * a pair of cards competing with the composer.
 */
export function WebLanding({ name, suggestions }: WebLandingProps) {
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
            <li key={suggestion.id}>
              <button
                type="button"
                className="v-chat__suggestion"
                onClick={() => navigateToHash(suggestion.hash)}
              >
                {suggestion.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

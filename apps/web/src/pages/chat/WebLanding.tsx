import { BrandMark } from '../../components/brand/BrandMark';
import { SuggestionList } from './SuggestionList';
import type { Suggestion } from './suggestions';

export interface WebLandingProps {
  readonly name: string | null;
  readonly suggestions: readonly Suggestion[];
  readonly onDismiss: (id: string) => void;
}

/**
 * The website's empty state: the mark, a greeting, then the ways in. The lines
 * sit in the composer's column so the eye runs straight down from the greeting
 * to the sentence you could type.
 */
export function WebLanding({ name, suggestions, onDismiss }: WebLandingProps) {
  return (
    <div className="v-chat__hero">
      <BrandMark size={56} decorative />
      <h1 className="v-chat__greeting">
        {name === null ? 'Hey there,' : `Hey ${name},`}
        <span className="v-chat__greeting-line">what should we build?</span>
      </h1>
      {suggestions.length > 0 && <SuggestionList suggestions={suggestions} onDismiss={onDismiss} />}
    </div>
  );
}

import { navigateToHash } from '../../shell/useHashRoute';
import { DocumentIcon, MailIcon, PencilIcon } from './chatIcons';
import type { Suggestion } from './suggestions';

export interface QuickPromptsProps {
  readonly suggestions: readonly Suggestion[];
  /** Writes a suggestion's words into the type box, without sending them. */
  readonly onPrompt: (prompt: string) => void;
  /** Names the row for a screen reader. */
  readonly label?: string;
}

function SuggestionIcon({ suggestion }: { readonly suggestion: Suggestion }) {
  if (suggestion.icon === 'mail') return <MailIcon />;
  if (suggestion.icon === 'pencil') return <PencilIcon />;
  return <DocumentIcon />;
}

/**
 * The ways in, as the reference draws them: a single row of short chips sitting
 * against the type box, not sentences stranded in the middle of the screen.
 *
 * Measured from the reference capture (a 461px-wide phone screenshot, converted
 * at 0.89 px per dp): chips 34dp tall, 12dp corners, 9dp apart, 15dp of side
 * padding and the row about 6dp off the box. The type is the same 13px the
 * reference's chips use, which is this page's small token.
 *
 * A chip is never decorative. A link chip navigates where its label says; a
 * prompt chip writes its words into the type box and leaves them there, unsent,
 * so the person reads what they are about to ask before it costs anything. The
 * full sentence the site already carried stays on the chip as its accessible
 * name, so the short label costs a screen reader nothing.
 */
export function QuickPrompts({
  suggestions,
  onPrompt,
  label = 'Ways to get started',
}: QuickPromptsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="v-chat__prompts" role="group" aria-label={label}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          className="v-chat__prompt"
          aria-label={`${suggestion.title}. ${suggestion.actionLabel}`}
          onClick={() => {
            if (suggestion.kind === 'link') navigateToHash(suggestion.hash);
            else onPrompt(suggestion.prompt);
          }}
        >
          <span className="v-chat__prompt-icon" aria-hidden="true">
            <SuggestionIcon suggestion={suggestion} />
          </span>
          <span className="v-chat__prompt-label">{suggestion.shortLabel}</span>
        </button>
      ))}
    </div>
  );
}

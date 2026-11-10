/**
 * The ways in from an empty conversation. Each is one of two real things, never
 * an illustration;
 *
 * - `link` goes where it says it goes (a route of this app), and
 * - `prompt` writes the first message for you, so a person who does not know how
 *   to ask for something can still ask for it. The words land in the type box,
 *   unsent: what is sent stays the person's own decision.
 */
export type SuggestionIcon = 'pencil' | 'document' | 'mail';

export type Suggestion = {
  readonly id: string;
  readonly icon: SuggestionIcon;
  /** The plain sentence, in the muted colour. */
  readonly title: string;
  /** The coloured words that name what pressing it does. */
  readonly actionLabel: string;
} & (
  | { readonly kind: 'link'; readonly hash: string }
  | { readonly kind: 'prompt'; readonly prompt: string }
);

export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'email',
    icon: 'mail',
    title: 'Let your agent send and manage emails on your behalf',
    actionLabel: 'Connect email address',
    kind: 'prompt',
    // Filled into the composer, never sent on its own. The wording is the
    // owner's own request, kept character for character.
    prompt: 'Connect a Email address for me so you can send and manage email on my behalf',
  },
  {
    id: 'documents',
    icon: 'document',
    title: 'Ask questions about your own documents',
    actionLabel: 'Open document intelligence',
    kind: 'link',
    hash: '#/documents',
  },
];

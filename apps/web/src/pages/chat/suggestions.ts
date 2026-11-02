/**
 * The two ways in from an empty conversation. Both are real destinations, so
 * neither is an illustration: each goes where it says it goes.
 */
export interface Suggestion {
  readonly id: string;
  readonly icon: 'pencil' | 'document';
  /** The plain sentence, in the muted colour. */
  readonly title: string;
  /** The coloured words that name the destination. */
  readonly actionLabel: string;
  readonly hash: string;
}

export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'builder',
    icon: 'pencil',
    title: 'Start something new from an empty project',
    actionLabel: 'Open the app builder',
    hash: '#/builder',
  },
  {
    id: 'documents',
    icon: 'document',
    title: 'Ask questions about your own documents',
    actionLabel: 'Open document intelligence',
    hash: '#/documents',
  },
];

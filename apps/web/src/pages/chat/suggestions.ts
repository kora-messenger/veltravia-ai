/**
 * The two ways in from an empty conversation. Both are real destinations, so
 * neither is an illustration: each goes where it says it goes.
 */
export interface Suggestion {
  readonly id: string;
  readonly title: string;
  /** The short form the app layout uses, where the title would wrap. */
  readonly short: string;
  readonly hash: string;
}

export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'builder',
    title: 'Start something new from an empty project',
    short: 'Build something new',
    hash: '#/builder',
  },
  {
    id: 'documents',
    title: 'Ask questions about your own documents',
    short: 'Ask about your documents',
    hash: '#/documents',
  },
];

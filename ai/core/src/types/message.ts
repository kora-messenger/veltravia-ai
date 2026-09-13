/** Roles a message may take in a Veltravia AI conversation. */
export type AIMessageRole = 'system' | 'user' | 'assistant';

/** One message in a conversation. Content is plain text for now. */
export interface AIMessage {
  readonly role: AIMessageRole;
  readonly content: string;
}

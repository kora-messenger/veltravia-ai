/** Token usage metadata, when a provider reports it. All fields optional. */
export interface AIUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

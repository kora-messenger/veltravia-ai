/** Token usage metadata, when a provider reports it. All fields optional. */
export interface AIUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /**
   * The part of `inputTokens` the provider served from its own cache. Always a
   * subset of `inputTokens`, never an addition to it, so a caller that ignores
   * this field still counts every prompt token exactly once. Absent means the
   * provider did not report it - not that nothing was cached.
   */
  readonly cachedInputTokens?: number;
}

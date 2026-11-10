/**
 * The completion port.
 *
 * The model-powered coding agent never speaks to a provider itself: it asks
 * this port for one completion and receives text back. In production the port
 * is implemented on top of the existing AI provider gateway (Step 26-29 path),
 * which owns the credential, the routing decision, the usage record and
 * cancellation. That is why this package imports no provider SDK and can be
 * tested deterministically offline.
 */

export interface CodingModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CodingModelRequest {
  readonly messages: readonly CodingModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  /** Aborted when the run is cancelled. */
  readonly signal?: AbortSignal;
  /**
   * The coding run this call belongs to. Billing takes one hold per run and
   * settles it from every call that names the same id, so a retried call is not
   * a second charge.
   */
  readonly correlationId?: string;
}

export interface CodingModelReply {
  /** The raw text the model returned. UNTRUSTED - parsed before anything acts. */
  readonly text: string;
  /** Which connection answered. Never a credential. */
  readonly providerId: string;
  readonly modelId: string;
  /** True only when a real provider answered; false for a fixture transport. */
  readonly live: boolean;
  readonly usage?: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
}

export interface CodingModelClient {
  /** Human-readable provider name for the UI ("OpenAI", "Anthropic", ...). */
  readonly providerName: string;
  complete(request: CodingModelRequest): Promise<CodingModelReply>;
}

export type CodingModelClientResult =
  | { readonly ok: true; readonly client: CodingModelClient }
  | { readonly ok: false; readonly reason: string; readonly code: string };

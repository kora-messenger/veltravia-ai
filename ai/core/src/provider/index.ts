import type { AIModelInfo } from '../types/model.js';
import type { AIRequest } from '../types/request.js';
import type { AIResponse } from '../types/response.js';

/**
 * The provider-neutral contract every Veltravia AI provider must implement.
 *
 * `send` receives the already-routed request plus the resolved model entry.
 * Adapters translate this into their vendor's format and MUST return a
 * normalized AIResponse (and MUST throw normalized AIError subclasses on
 * failure). This is the only seam where vendor formats are allowed to exist.
 *
 * Streaming (planned later, see docs/architecture.md): the interface will
 * grow an OPTIONAL `sendStream(request, model): AsyncIterable<AIChunk>` -
 * a separate, optional capability, so non-streaming providers never change.
 */
export interface AIProvider {
  /** Veltravia provider id (e.g. 'mock'). Must be unique across the platform. */
  readonly id: string;
  readonly displayName: string;
  /** Generate a completion for the resolved model, normalized. */
  send(request: AIRequest, model: AIModelInfo): Promise<AIResponse>;
}

import { GatewayError, isGatewayError } from '../errors/index.js';
import { assertSafeEndpoint } from '../ssrf/index.js';

/**
 * The network seam for provider adapters.
 *
 * Adapters never call `fetch` themselves. Everything goes through a transport,
 * which keeps three properties true in one place:
 *   - every URL is validated by the SSRF guard before it is fetched (including
 *     a custom base URL supplied by an owner);
 *   - redirects are refused rather than followed, so a 302 cannot walk a
 *     request from a public host to an internal one;
 *   - a timeout always ends the request, even if the socket does not.
 */

export interface TransportRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  /** Skip DNS revalidation (used for catalog hosts, never custom endpoints). */
  readonly trustedHost?: boolean;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON when the body was JSON, otherwise undefined. */
  readonly body: unknown;
  /** Raw text (bounded) - used for SSE parsing. */
  readonly text: string;
}

/** A streamed request: same rules as a normal one, plus cancellation. */
export interface TransportStreamRequest extends TransportRequest {
  /** Aborted when the caller cancels (client disconnect, operator cancel). */
  readonly signal?: AbortSignal;
  /** Abort when no chunk arrives within this window. Never a total cap. */
  readonly idleTimeoutMs?: number;
}

/**
 * What an incremental transport yields: the status line first, then raw body
 * fragments exactly as they arrived. Parsing is the adapter's job, so protocol
 * shapes stay in one place per vendor.
 */
export type TransportStreamEvent =
  | {
      readonly type: 'head';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly type: 'chunk'; readonly text: string };

export interface ProviderTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
  /**
   * Optional. When absent, adapters fall back to reading a buffered response as
   * one piece - still correct, just not progressive. Reported honestly upward.
   */
  requestStream?(request: TransportStreamRequest): AsyncIterable<TransportStreamEvent>;
}

const MAX_BODY_BYTES = 2_000_000;
const MAX_STREAM_BYTES = 4_000_000;

export interface FetchTransportOptions {
  /** DNS resolver override for the SSRF guard (tests). */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Allows plain HTTP. Tests only. */
  readonly allowInsecure?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export class FetchProviderTransport implements ProviderTransport {
  private readonly options: FetchTransportOptions;

  constructor(options: FetchTransportOptions = {}) {
    this.options = options;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    if (!request.trustedHost) {
      await assertSafeEndpoint(request.url, {
        ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
        ...(this.options.allowInsecure ? { allowInsecure: true } : {}),
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        // Refuse to follow redirects: a 3xx is reported to the adapter, which
        // turns it into a normalized provider error.
        redirect: 'manual',
      });
      const text = await response.text();
      const bounded = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      let body: unknown;
      try {
        body = bounded.length > 0 ? JSON.parse(bounded) : undefined;
      } catch {
        body = undefined;
      }
      return { status: response.status, headers, body, text: bounded };
    } catch (error) {
      // A timeout is a normalized category, not a raw DOMException: callers and
      // usage records must never depend on runtime-specific error shapes.
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new GatewayError(
          'GATEWAY_TIMEOUT',
          'The provider did not answer within the time limit.',
          {
            details: { timeoutMs: request.timeoutMs },
          },
        );
      }
      throw new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'The provider could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Incremental read. The SSRF guard runs first, redirects are refused, and an
   * idle timer aborts a socket that stops producing output - so a stalled
   * provider cannot hold a run open forever.
   */
  async *requestStream(request: TransportStreamRequest): AsyncIterable<TransportStreamEvent> {
    if (!request.trustedHost) {
      await assertSafeEndpoint(request.url, {
        ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
        ...(this.options.allowInsecure ? { allowInsecure: true } : {}),
      });
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const idleTimeoutMs = request.idleTimeoutMs ?? request.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    armIdleTimer();
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: 'manual',
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      yield { type: 'head', status: response.status, headers };
      if (request.signal?.aborted === true) {
        throw new GatewayError('GATEWAY_ABORTED', 'The request was cancelled.');
      }
      if (response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdleTimer();
          if (value !== undefined) {
            total += value.byteLength;
            if (total > MAX_STREAM_BYTES) {
              throw new GatewayError(
                'GATEWAY_PROVIDER_ERROR',
                'The provider stream exceeded the size limit.',
              );
            }
            const text = decoder.decode(value, { stream: true });
            if (text.length > 0) yield { type: 'chunk', text };
          }
        }
      } finally {
        // Releasing the reader is what actually frees the socket when the
        // caller stops iterating early.
        reader.releaseLock();
      }
    } catch (error) {
      if (isGatewayError(error)) throw error;
      if (request.signal?.aborted === true) {
        throw new GatewayError('GATEWAY_ABORTED', 'The request was cancelled.');
      }
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new GatewayError('GATEWAY_TIMEOUT', 'The provider stopped responding.');
      }
      throw new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'The provider could not be reached.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

/** Deterministic transport for tests and offline CI. No sockets. */
export class ScriptedProviderTransport implements ProviderTransport {
  readonly requests: TransportRequest[] = [];
  private readonly handler: (
    request: TransportRequest,
  ) => Promise<TransportResponse> | TransportResponse;

  constructor(
    handler: (request: TransportRequest) => Promise<TransportResponse> | TransportResponse,
  ) {
    this.handler = handler;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.handler(request);
  }

  /** Optional: lets a test drive the incremental path too. */
  readonly streamHandler?: (request: TransportStreamRequest) => AsyncIterable<TransportStreamEvent>;

  withStreamHandler(
    handler: (request: TransportStreamRequest) => AsyncIterable<TransportStreamEvent>,
  ): this {
    (this as { streamHandler?: typeof handler }).streamHandler = handler;
    return this;
  }

  async *requestStream(request: TransportStreamRequest): AsyncIterable<TransportStreamEvent> {
    if (!this.streamHandler) {
      throw new GatewayError('GATEWAY_CAPABILITY_UNSUPPORTED', 'This transport cannot stream.');
    }
    yield* this.streamHandler(request);
  }
}

import { GatewayError } from '../errors/index.js';
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

export interface ProviderTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

const MAX_BODY_BYTES = 2_000_000;

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
}

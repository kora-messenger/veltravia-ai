/**
 * The GitHub transport: the ONLY network seam of the GitHub Connector.
 *
 * SECURITY DESIGN (hard rules, enforced here rather than trusted to callers):
 * - The base endpoint is FIXED (https://api.github.com). No user-supplied
 *   host, proxy, scheme, or absolute URL can ever be reached.
 * - A request carries a RELATIVE path only. Absolute URLs, protocol changes,
 *   "//", ".." and backslash segments are rejected before any connection.
 * - The HTTP method is chosen by the transport's typed request constructor,
 *   never by the caller: the AI cannot cause arbitrary API calls.
 * - Authorization happens HERE, at call time, from the token provider - the
 *   raw token never lives in connector state, tool metadata, or logs.
 * - Redirects are refused (redirect: 'error'): a GitHub response can never
 *   bounce an authenticated request to an attacker-controlled host.
 */

import { GitHubError } from './errors.js';

/** The fixed, only endpoint the connector will ever talk to. */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

export const GITHUB_TRANSPORT_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export type GitHubTransportMethod = (typeof GITHUB_TRANSPORT_METHODS)[number];

/** A validated transport request. Constructed only by this file's helpers. */
export interface GitHubTransportRequest {
  readonly method: GitHubTransportMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** A normalized transport response. Bodies are passed through UNPARSED - the
 * client maps and maps them into stable views; nothing here trusts a body. */
export interface GitHubTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The transport contract. The offline fake in `testing.ts` implements it too. */
export interface GitHubTransport {
  request(request: GitHubTransportRequest): Promise<GitHubTransportResponse>;
}

/** Validates a relative API path. Rejects every URL-injection shape. */
export function assertSafeApiPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('api path must be a non-empty string');
  }
  if (path.length > 2048) {
    throw new Error('api path is too long');
  }
  if (!path.startsWith('/')) {
    throw new Error('api path must be relative and start with "/"');
  }
  if (path.includes('://') || path.includes('\\')) {
    throw new Error('api path must not contain absolute URL material');
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('api path must not contain traversal segments');
  }
  /* eslint-disable no-control-regex -- rejecting control characters is the
     entire point of this check. */
  if (/[\x00-\x1f\x7f]/.test(path)) {
    /* eslint-enable no-control-regex */
    throw new Error('api path must not contain control characters');
  }
}

/** URL-encodes one query parameter value. */
function encodeQueryValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Builds the final URL. Package-private by construction: fixed base only. */
function buildUrl(
  base: string,
  path: string,
  query?: Readonly<Record<string, string | number>>,
): string {
  assertSafeApiPath(path);
  let url = `${base}${path}`;
  if (query !== undefined) {
    const entries = Object.entries(query);
    if (entries.length > 0) {
      const pairs = entries.map(
        ([key, value]) => `${encodeURIComponent(key)}=${encodeQueryValue(value)}`,
      );
      url = `${url}?${pairs.join('&')}`;
    }
  }
  return url;
}

export interface HttpsGitHubTransportOptions {
  /** Token provider - called once per request; the value is never retained. */
  readonly getToken: () => Promise<string>;
  /** Request timeout in milliseconds. Default: 10s. */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The production HTTPS transport. Talks to api.github.com ONLY, with a fixed
 * Accept header, no redirects, and a hard timeout. Every response is
 * normalized into { status, body } - headers are discarded immediately so no
 * token-bearing or otherwise sensitive header material can propagate.
 */
export function createHttpsGitHubTransport(options: HttpsGitHubTransportOptions): GitHubTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
      const url = buildUrl(GITHUB_API_BASE_URL, request.path, request.query);
      const token = await options.getToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(url, {
          method: request.method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          redirect: 'error',
          signal: controller.signal,
        });
        const text = await response.text();
        let body: unknown = null;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { raw: text.slice(0, 2048) };
          }
        }
        return { status: response.status, body };
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        if (controller.signal.aborted) {
          throw new GitHubError('GITHUB_TIMEOUT', 'GitHub request timed out');
        }
        throw new GitHubError(
          'GITHUB_NETWORK_ERROR',
          `GitHub request failed: ${(error as Error).message ?? 'network error'}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

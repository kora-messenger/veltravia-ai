import { runtimeConfig } from '../config/runtime-config.js';
/**
 * Frontend API client foundation.
 *
 * A single, small transport layer so components never call `fetch` directly.
 * Errors are normalized to `ApiError` with a machine `code` and a
 * user-presentable message; internal details (stack traces, raw payloads)
 * never reach the UI.
 */

/** Error codes surfaced to the UI. `NETWORK` is client-generated. */
export type ApiErrorCode = string;

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const NETWORK_ERROR = new ApiError(0, 'NETWORK', 'Cannot reach the Veltravia AI service.');

/**
 * How a request failed *before* the server accepted it.
 *
 * These are the states the chat has to tell apart, because each one gets a
 * different answer: `offline` means the device knows it has no connection, so
 * the message goes back to the composer untouched; `timeout` means the request
 * left but nothing came back in time, so it may or may not have arrived;
 * `network` means it never reached the service. Everything else is the server's
 * own answer, which already names itself.
 */
export type TransportFailure = 'offline' | 'timeout' | 'network';

export class TransportError extends Error {
  readonly failure: TransportFailure;

  constructor(failure: TransportFailure, message: string) {
    super(message);
    this.name = 'TransportError';
    this.failure = failure;
  }
}

/** True when the browser says it has no connection at all. */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

function parseErrorBody(raw: unknown): { code?: string; message?: string } {
  if (typeof raw === 'object' && raw !== null) {
    const body = raw as ErrorBody;
    if (body.error !== undefined && typeof body.error === 'object') {
      return {
        code: typeof body.error.code === 'string' ? body.error.code : undefined,
        message: typeof body.error.message === 'string' ? body.error.message : undefined,
      };
    }
  }
  return {};
}

/**
 * Performs a JSON request against the API.
 *
 * `baseUrl` defaults to the runtime configuration: '' for the browser build
 * (same origin, proxied by the dev server or the host), or the configured
 * absolute URL inside the Android application, which has no same-origin API.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    headers?: Readonly<Record<string, string>>;
    /**
     * Ceiling for the whole request. The chat sets one so "Thinking" cannot sit
     * there for ever when a request is accepted and then silently dropped -
     * which is exactly what a captive portal or a dropped tunnel does.
     */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const {
    method = 'GET',
    body,
    baseUrl = runtimeConfig().apiBaseUrl,
    fetchImpl = fetch,
    headers,
    timeoutMs,
  } = options;

  // An offline device is told so immediately: waiting out a timeout to say
  // "you are offline" is the slowest possible way to say something known.
  if (isOffline()) {
    throw new TransportError('offline', 'You are offline. Your message was not sent.');
  }

  const controller = timeoutMs === undefined ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller !== null && timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers:
        body === undefined && headers === undefined
          ? undefined
          : { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
  } catch (error) {
    const aborted = controller !== null && controller.signal.aborted;
    if (aborted) {
      throw new TransportError(
        'timeout',
        'The service did not answer in time. Your message may not have been sent.',
      );
    }
    if (isOffline()) {
      throw new TransportError('offline', 'You are offline. Your message was not sent.');
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TransportError('timeout', 'The request was stopped before an answer arrived.');
    }
    throw NETWORK_ERROR;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const { code, message } = parseErrorBody(payload);
    throw new ApiError(
      response.status,
      code ?? 'UNKNOWN',
      message ?? friendlyMessage(response.status, code),
    );
  }
  return payload as T;
}

/** Maps a raw error to text that is safe and useful to show a user. */
export function errorMessage(error: unknown): string {
  if (error instanceof TransportError) return error.message;
  if (error instanceof ApiError) {
    return error.message || friendlyMessage(error.status, error.code);
  }
  return 'Something went wrong. Please try again.';
}

function friendlyMessage(status: number, code?: string): string {
  if (status === 0 || code === 'NETWORK') {
    return 'Cannot reach the Veltravia AI service. Check your connection and try again.';
  }
  if (status === 400) {
    return 'That request was not valid. Please check the entered values.';
  }
  if (status === 404 || code === 'PROJECT_NOT_FOUND' || code === 'WORKSPACE_NOT_FOUND') {
    return 'This project no longer exists or could not be found.';
  }
  if (status === 409) {
    return 'This changed on the server while you were working. The latest version has been loaded.';
  }
  if (status >= 500) {
    return 'The Veltravia AI service had a problem. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

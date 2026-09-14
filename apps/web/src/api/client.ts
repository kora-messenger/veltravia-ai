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
 * `baseUrl` is '' by default (same origin); the dev server proxies `/api` to
 * the backend, and deployments can override it with `VITE_API_BASE_URL`.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<T> {
  const { method = 'GET', body, baseUrl = '', fetchImpl = fetch } = options;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw NETWORK_ERROR;
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

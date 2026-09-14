/**
 * Typed, scrubbed GitHub Connector errors. GitHub response bodies, headers,
 * and failure text NEVER cross this boundary raw - every failure becomes a
 * GitHubError with a stable code and a scrubbed message, so a token that
 * leaks into an upstream error message is redacted before it can reach the
 * model, an API response, or an audit record.
 */

export const GITHUB_ERROR_CODES = [
  'GITHUB_INVALID_INPUT',
  'GITHUB_SCOPE_DENIED',
  'GITHUB_UNAUTHORIZED',
  'GITHUB_FORBIDDEN',
  'GITHUB_NOT_FOUND',
  'GITHUB_CONFLICT',
  'GITHUB_VALIDATION',
  'GITHUB_RATE_LIMITED',
  'GITHUB_SERVER_ERROR',
  'GITHUB_TIMEOUT',
  'GITHUB_NETWORK_ERROR',
  'GITHUB_INVALID_RESPONSE',
] as const;

export type GitHubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** Secret-shaped patterns scrubbed from every GitHub error and audit surface. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Scrubs secret-shaped substrings (GitHub tokens included) from text. */
export function scrubGitHubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
}

export interface GitHubErrorOptions {
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Every GitHub failure the connector surfaces - typed and scrubbed. */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: GitHubErrorCode, message: string, options: GitHubErrorOptions = {}) {
    super(scrubGitHubSecrets(message), { cause: options.cause });
    this.name = 'GitHubError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) {
      this.details = JSON.parse(scrubGitHubSecrets(JSON.stringify(options.details))) as Readonly<
        Record<string, unknown>
      >;
    }
  }

  /** Serializable, stack-free, secret-free view for higher layers. */
  toJSON(): {
    code: GitHubErrorCode;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.details !== undefined ? { details: { ...this.details } } : {}),
    };
  }
}

export function isGitHubError(value: unknown): value is GitHubError {
  return value instanceof GitHubError;
}

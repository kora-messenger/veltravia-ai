/**
 * Secret scrubbing for sandbox output and audit records.
 *
 * Sandbox stdout/stderr are UNTRUSTED DATA and may contain secrets that
 * untrusted code accidentally printed. Everything returned to callers or
 * written to audit goes through here first. Self-contained on purpose -
 * the sandbox depends on nothing.
 */

/** Value shapes that mark content as secret-shaped. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /eyJhbGciOi[A-Za-z0-9._-]{20,}/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/gi,
];

/** Replacement marker - irreversible and clearly labeled. */
const REDACTED = '[REDACTED:secret]';

/** True if a string contains secret-shaped content. */
export function containsSecretShapedContent(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => new RegExp(pattern.source).test(text));
}

/**
 * Replaces every secret-shaped fragment in `text` with a redaction marker.
 * Returns the scrubbed text and the number of fragments removed.
 */
export function scrubSecrets(text: string): { scrubbed: string; count: number } {
  let count = 0;
  let result = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, () => {
      count += 1;
      return REDACTED;
    });
  }
  return { scrubbed: result, count };
}

/** True if a single environment/metadata VALUE looks like a credential. */
export function isSecretLikeValue(value: string): boolean {
  // Reuse the pattern set; single-shot test without global-flag state.
  return SECRET_VALUE_PATTERNS.some((pattern) => new RegExp(pattern.source).test(value));
}

/** Scrubs a structured details map for audit events: values never survive. */
export function scrubDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      safe[key] = scrubSecrets(value).scrubbed;
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      value === undefined
    ) {
      safe[key] = value;
    } else {
      // Objects/arrays: serialize, scrub, keep as string (bounded).
      safe[key] = scrubSecrets(safeStringify(value)).scrubbed;
    }
  }
  return safe;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

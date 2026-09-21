/**
 * Secret detection for Version Control (Step 18).
 *
 * Semantics deliberately mirror the Project Engine's secret module so the
 * two layers never disagree: value-shaped credentials are refused anywhere
 * they appear in captured content, and errors name PATHS, never values.
 */

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /AIzaSy[A-Za-z0-9_-]{10,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^Bearer\s+[A-Za-z0-9._-]{15,}$/,
  /^eyJhbGciOi[A-Za-z0-9._-]{20,}$/,
];

/** True if file content contains secret-shaped material (paths only in errors). */
export function containsSecretShapedContent(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

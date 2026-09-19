/**
 * Shared secret-shaped value scrubbing for the Project Memory & Knowledge
 * System. Bounded, dependency-free, and deliberately conservative: when in
 * doubt the value is redacted. Memory content can carry untrusted project
 * text, so every piece that reaches a view, audit record, or error message
 * passes through here.
 */

const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REDACTED = '[redacted]';

/** Replaces every secret-shaped value in the text with a redaction marker. */
export function scrubSecretShapedValues(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

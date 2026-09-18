/**
 * Shared secret-shaped value scrubbing for the Testing & Debugging Agent.
 * Bounded, dependency-free, and deliberately conservative: when in doubt the
 * value is redacted. Test command output is UNTRUSTED DATA, so every piece of
 * it that reaches a view, diagnosis, or audit passes through here.
 */

const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
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

/** Bounded + scrubbed summary of raw (untrusted) command output. */
export function summarizeUntrustedOutput(input: string, maxLength = 1000): string {
  const scrubbed = scrubSecretShapedValues(input);
  if (scrubbed.length <= maxLength) return scrubbed;
  return `${scrubbed.slice(0, maxLength)}…[truncated]`;
}

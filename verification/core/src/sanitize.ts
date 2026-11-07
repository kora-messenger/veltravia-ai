/**
 * Sanitising - Step 45.
 *
 * Test output is untrusted text that frequently contains exactly what must not
 * be stored or handed to a model: tokens, connection strings, key assignments.
 * Everything leaving this package passes through here first.
 */

const PATTERNS: readonly [RegExp, string][] = [
  [/\b(sk|rk)-[A-Za-z0-9_-]{10,}/g, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [redacted]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, '[redacted-database-url]'],
  [
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"',;]{6,}/g,
    '$1=[redacted]',
  ],
];

/** Removes secret-shaped fragments and reports how many were removed. */
export function scrubSecrets(input: string): { text: string; removed: number } {
  let text = input;
  let removed = 0;
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, (...args) => {
      removed += 1;
      return replacement.replace('$1', String(args[1] ?? ''));
    });
  }
  return { text, removed };
}

/** Bounded tail of a stream, measured in bytes, cut on a line boundary. */
export function boundedTail(input: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return { text: input, truncated: false };
  const buffer = Buffer.from(input, 'utf8');
  const slice = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  const newline = slice.indexOf('\n');
  return { text: newline === -1 ? slice : slice.slice(newline + 1), truncated: true };
}

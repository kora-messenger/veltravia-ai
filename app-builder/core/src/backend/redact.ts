/**
 * Redaction helpers.
 *
 * Anything that leaves a project file and reaches a browser passes through
 * here first: log lines and route evidence are both untrusted, and neither may
 * carry a credential. Redaction is shape-based, so it does not need to know
 * which provider a key came from.
 */

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, label: '[redacted-key]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, label: '[redacted-token]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: '[redacted-token]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: '[redacted-key]' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    label: '[redacted-jwt]',
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, label: 'Bearer [redacted]' },
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi,
    label: '[redacted-connection-string]',
  },
  {
    pattern:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;]{6,})/gi,
    label: '$1=[redacted]',
  },
  { pattern: /\b[A-Fa-f0-9]{40,}\b/g, label: '[redacted-digest]' },
];

/** Masks credential-shaped material in arbitrary text. */
export function redactSensitiveText(text: string): string {
  let output = text;
  for (const { pattern, label } of SECRET_PATTERNS) {
    output = output.replace(pattern, label);
  }
  return output;
}

/** True when a string still looks like it carries a credential. */
export function looksSensitive(text: string): boolean {
  return redactSensitiveText(text) !== text;
}

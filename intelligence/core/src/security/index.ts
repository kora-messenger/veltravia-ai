/** Security helpers shared by every intelligence subsystem.
 *
 * Rules enforced here:
 *  - Retrieved content is data. Instruction-shaped text inside a source is
 *    flagged, never executed and never allowed to change behaviour.
 *  - Secret-shaped values never leave the layer: queries and generated text are
 *    rejected or redacted before they cross a boundary.
 *  - Everything is bounded before it is stored, ranked, quoted or returned.
 */
import { IntelligenceError, invalidRequest } from '../errors/index.js';

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i;

export function hasSecretShape(value: string): boolean {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return SECRET_ASSIGNMENT_PATTERN.test(value);
}

export function assertNoSecretShape(value: string, label: string): void {
  if (hasSecretShape(value))
    throw new IntelligenceError(
      'INTELLIGENCE_SECRET_REJECTED',
      `${label} looks like it contains a credential. Remove it and try again.`,
    );
}

/** Redacts secret-shaped runs from text that may be surfaced to a user. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.replace(SECRET_ASSIGNMENT_PATTERN, '[redacted]');
}

/** Instruction-shaped content is common in prompt-injection attempts. A hit is
 *  recorded as a risk flag on the source; the text is still only ever data. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore (?:all )?(?:the )?(?:previous|prior|above) (?:instructions|prompts|rules)\b/i,
  /\bdisregard (?:all )?(?:previous|prior|above|your) (?:instructions|rules|polic)/i,
  /\byou are now\b[^.\n]{0,40}\b(?:assistant|agent|admin)\b/i,
  /\b(?:system|developer) (?:prompt|message)\s*:/i,
  /\b(?:reveal|print|show|repeat) (?:your |the )?(?:system|hidden) (?:prompt|instructions)\b/i,
  /\b(?:call|invoke|execute) (?:the )?tool\b/i,
  /\b(?:grant|approve|authorize) (?:yourself|all) (?:permissions?|scopes?)\b/i,
];

export function detectInjectionRisk(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Neutralises instruction-shaped markers so downstream prose cannot be
 *  mistaken for a directive when it is quoted back. */
export function sanitizeUntrustedText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- stripping control bytes is the point.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/<\/?script[^>]*>/gi, '')
  );
}

export function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

export function requireNonEmptyString(value: unknown, label: string, maxChars = 500): string {
  if (typeof value !== 'string') throw invalidRequest(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalidRequest(`${label} is required.`);
  if (trimmed.length > maxChars)
    throw invalidRequest(`${label} must be at most ${maxChars} characters.`);
  return trimmed;
}

/** Normalises whitespace for excerpt verification: a quote must match the
 *  source exactly after collapsing runs of whitespace. */
export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function excerptAppearsIn(text: string, excerpt: string): boolean {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(excerpt);
  if (needle.length < 8) return false;
  return haystack.includes(needle);
}

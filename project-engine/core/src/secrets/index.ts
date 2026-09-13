/**
 * Secret detection for the Project Engine.
 *
 * The Project Engine never stores secrets: configuration, context, metadata,
 * and integration references are all validated against secret-like keys and
 * secret-shaped values. Rejections name FIELDS and RULES, never values.
 */

import { SecretRejectedError } from '../errors/index.js';

/**
 * Lowercase, separator-stripped substrings that mark a field NAME as
 * secret-like. Matching normalizes separators AND case, so camelCase
 * (`clientSecret`), snake_case (`client_secret`), and kebab-case
 * (`client-secret`) are all caught.
 */
const SECRET_KEY_PLAIN_SUBSTRINGS = [
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'token',
  'credential',
  'privatekey',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'oauth',
  'signature',
] as const;

/** Field names that are ALWAYS rejected, even without matching the general list. */
const FORBIDDEN_KEY_EXACT = new Set([
  'apikey',
  'api_key',
  'api-key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'privateKey',
  'private_key',
  'password',
  'pass',
  'pwd',
  'secret',
  'token',
]);

/** Value shapes that mark content as secret-shaped, regardless of field name. */
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

/** True if a metadata/config/context field NAME marks the field as secret-like. */
export function isSecretLikeKey(key: string): boolean {
  if (FORBIDDEN_KEY_EXACT.has(key)) return true;
  const plain = key.toLowerCase().replace(/[_\-\s]/g, '');
  return SECRET_KEY_PLAIN_SUBSTRINGS.some((needle) => plain.includes(needle));
}

/** True if a VALUE looks like a credential, regardless of its field name. */
export function isSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validates a plain metadata record for secret-like content.
 * Returns the list of rejected FIELD names (never values).
 */
export function findSecretLikeFields(record: Record<string, unknown>): string[] {
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (isSecretLikeKey(key)) {
      rejected.push(`field "${key}" is secret-like`);
      continue;
    }
    if (typeof value === 'string' && isSecretLikeValue(value)) {
      rejected.push(`field "${key}" has a secret-shaped value`);
    }
  }
  return rejected;
}

/** Validates metadata and throws a scrubbed `SecretRejectedError` on violations. */
export function assertNoSecrets(surface: string, record: Record<string, unknown>): void {
  const violations = findSecretLikeFields(record);
  if (violations.length > 0) {
    throw new SecretRejectedError(surface, violations);
  }
}

/** True if a string contains secret-shaped content (used for context entries). */
export function containsSecretShapedContent(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

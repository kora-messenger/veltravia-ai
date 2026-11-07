/**
 * Credential screening for proposed content.
 *
 * The project engine's detector is anchored: it matches a value that IS a
 * credential, not one embedded in a source file. A worker writes source files,
 * so this walks the text instead of testing it whole.
 */

import { containsSecretShapedContent } from '@veltravia/project-core';

const EMBEDDED_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:live|test|proj|ant)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIzaSy[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJhbGciOi[A-Za-z0-9._-]{20,}/,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/,
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
];

/**
 * True when the file looks like it carries a credential.
 *
 * Both checks matter: the anchored one catches a lone secret in a config, the
 * embedded ones catch a key pasted into a source file.
 */
export function looksLikeCredential(content: string): boolean {
  if (containsSecretShapedContent(content)) return true;
  if (EMBEDDED_PATTERNS.some((pattern) => pattern.test(content))) return true;
  // A token-by-token pass catches shapes the line patterns miss.
  for (const token of content.split(/[\s"'`,;(){}[\]]+/)) {
    if (token.length >= 24 && containsSecretShapedContent(token)) return true;
  }
  return false;
}

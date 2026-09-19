/**
 * Secret-shaped content detection for indexed source (Phase 24).
 *
 * The index must never intentionally store secrets. Source content IS
 * scanned during parsing; when secret-shaped content is detected the file
 * is FLAGGED (boolean only) and the surrounding evidence is scrubbed so
 * the raw value never enters the index, search results, summaries, or
 * audit output. The Project Engine remains the source of truth for file
 * contents - Codebase Intelligence only records that a file looks like it
 * contains a secret, never what the secret is.
 *
 * Pattern reuse: the detection functions come from @veltravia/project-core
 * so there is exactly ONE set of secret patterns in the platform.
 */

import { containsSecretShapedContent } from '@veltravia/project-core';

/**
 * Extracts double- or single-quoted string literals from one line, so the
 * engine's whole-value (anchored) secret patterns can fire on the LITERAL
 * itself rather than on the surrounding source text.
 */
function stringLiterals(line: string): string[] {
  const literals: string[] = [];
  const re = /"([^"\\\n]{4,})"|'([^'\\\n]{4,})'/g;
  let match: RegExpExecArray | null = re.exec(line);
  while (match !== null && literals.length < 8) {
    const value = match[1] ?? match[2];
    if (value !== undefined) {
      literals.push(value);
    }
    match = re.exec(line);
  }
  return literals;
}

/**
 * True when source content contains secret-shaped text. Bounded: only the
 * presence is recorded, and the caller must never retain the matched span.
 * Scans both the raw text (unanchored patterns) and each quoted literal
 * per line (anchored patterns like ^sk-…$).
 */
export function sourceContainsSecrets(content: string): boolean {
  try {
    if (containsSecretShapedContent(content)) {
      return true;
    }
    const lines = content.split('\n').slice(0, 2_000);
    for (const line of lines) {
      for (const literal of stringLiterals(line)) {
        if (containsSecretShapedContent(literal)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    // Detection must never crash indexing of a file.
    return false;
  }
}

/**
 * Scrubs evidence text so a secret-shaped value can never ride along in
 * relationship evidence or search output. Any run of "obviously secret"
 * characters is collapsed to a fixed placeholder.
 */
export function scrubEvidence(input: string, maxLength = 400): string {
  /* eslint-disable no-control-regex -- stripping control characters is the point */
  const cleaned = input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /* eslint-enable no-control-regex */
  const clamped = cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
  // Collapse common secret-shaped token runs (sk-, ghp_, AKIA..., long hex/base64 blobs).
  return clamped
    .replace(/\b(?:sk|pk|rk)_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(
      /\b-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----\b/g,
      '[redacted]',
    );
}

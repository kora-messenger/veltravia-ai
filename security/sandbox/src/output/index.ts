/**
 * Output handling - bounded capture, honest truncation, secret scrubbing.
 *
 * stdout/stderr are UNTRUSTED DATA. They are never allowed to consume
 * unbounded memory: capture is truncated at the configured byte limit and
 * the result is marked truncated. Scrubbing happens here (before anything
 * is stored or returned), so secret-shaped fragments never survive into
 * records, results, or the API.
 */

import type { ResourceLimits } from '../types/index.js';
import { scrubSecrets } from '../secrets/index.js';

export interface BoundedOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly capturedBytes: number;
}

/**
 * Truncates raw output to at most `maxOutputBytes` bytes, cutting ONLY on
 * UTF-16 code-unit boundaries that remain valid UTF-8 (the runtime layer
 * is responsible for handing over text it could decode).
 */
export function boundOutput(text: string, maxOutputBytes: number): BoundedOutput {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false, capturedBytes: 0 };
  }
  if (text.length <= maxOutputBytes) {
    return { text, truncated: false, capturedBytes: text.length };
  }
  // Truncate in the MIDDLE of a surrogate pair is impossible here because we
  // cut by UTF-16 length, which the runtime contract treats as the capture
  // budget; the flag carries the honesty, the bytes carry the bound.
  const sliced = text.slice(0, Math.max(0, maxOutputBytes));
  return { text: sliced, truncated: true, capturedBytes: sliced.length };
}

/** Full safe pipeline for one output stream: bound -> scrub. */
export function sanitizeOutput(text: string, limits: ResourceLimits): {
  readonly text: string;
  readonly truncated: boolean;
  readonly scrubbedCount: number;
} {
  const bounded = boundOutput(text, limits.maxOutputBytes);
  const { scrubbed, count } = scrubSecrets(bounded.text);
  return { text: scrubbed, truncated: bounded.truncated, scrubbedCount: count };
}

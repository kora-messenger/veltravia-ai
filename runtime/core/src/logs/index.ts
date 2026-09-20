/**
 * Runtime logs - structured, bounded, and scrubbed (Step 17).
 *
 * Application output that reaches a runtime log is UNTRUSTED DATA:
 *   - every message is length-capped and secret-scrubbed
 *   - control characters are stripped (no ANSI escapes, no log forgery)
 *   - the buffer is a fixed-size ring; old lines are dropped, never grown
 *   - total capture is bounded by the plan's maxLogBytes ceiling
 *
 * Log lines can never become instructions: nothing in this layer parses
 * them for commands, and consumers must treat them as display data only.
 */

import type { RuntimeLogEntry } from '../types/index.js';

export const MAX_LOG_MESSAGE_LENGTH = 2000;
export const MAX_LOG_ENTRIES = 500;

/* eslint-disable no-control-regex -- control characters are stripped, not matched for parsing */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */
const SECRET_SHAPED =
  /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g;

/** Scrub one log message: strip control characters and credential shapes. */
export function scrubLogMessage(message: string): string {
  if (typeof message !== 'string') {
    return '';
  }
  const stripped = message.replace(CONTROL_CHARS, '');
  const scrubbed = stripped.replace(SECRET_SHAPED, '[redacted]');
  if (scrubbed.length > MAX_LOG_MESSAGE_LENGTH) {
    return `${scrubbed.slice(0, MAX_LOG_MESSAGE_LENGTH)}…[truncated]`;
  }
  return scrubbed;
}

/** A bounded in-memory log ring for one runtime. */
export class RuntimeLogBuffer {
  private readonly entries: RuntimeLogEntry[] = [];
  private totalBytes = 0;
  private truncated = false;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('RuntimeLogBuffer requires a positive maxBytes ceiling');
    }
    this.maxBytes = maxBytes;
  }

  append(
    now: () => Date,
    level: RuntimeLogEntry['level'],
    phase: RuntimeLogEntry['phase'],
    rawMessage: string,
  ): RuntimeLogEntry {
    const message = scrubLogMessage(rawMessage);
    const entry: RuntimeLogEntry = {
      timestamp: now().toISOString(),
      level,
      phase,
      message,
    };
    const size = message.length + 96;
    this.entries.push(entry);
    this.totalBytes += size;
    // Rolling byte budget: drop the oldest lines until we are back under the
    // ceiling (always keeping at least the newest line).
    while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      this.totalBytes -= (dropped?.message.length ?? 0) + 96;
      this.truncated = true;
    }
    // Hard entry-count ceiling.
    while (this.entries.length > MAX_LOG_ENTRIES) {
      const dropped = this.entries.shift();
      this.totalBytes -= (dropped?.message.length ?? 0) + 96;
      this.truncated = true;
    }
    return entry;
  }

  /** Bounded snapshot, oldest first. */
  snapshot(): { entries: readonly RuntimeLogEntry[]; truncated: boolean } {
    return { entries: [...this.entries], truncated: this.truncated };
  }

  get byteCount(): number {
    return this.totalBytes;
  }
}

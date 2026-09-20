import { describe, expect, it } from 'vitest';
import { RuntimeLogBuffer, scrubLogMessage } from '@veltravia/runtime-core';

describe('runtime log scrubbing', () => {
  it('strips control characters (no ANSI forgery)', () => {
    const message = 'ok\u001b[31mRED\u001b[0m\u0007';
    expect(scrubLogMessage(message)).toBe('ok[31mRED[0m');
  });

  it('redacts credential-shaped output', () => {
    expect(scrubLogMessage('token ghp_' + 'a'.repeat(30) + ' leaked')).toContain('[redacted]');
    expect(scrubLogMessage('key sk-abcdefgh1234567890abc')).toContain('[redacted]');
  });

  it('truncates oversized messages with an honest marker', () => {
    const result = scrubLogMessage('x'.repeat(5000));
    expect(result.length).toBeLessThanOrEqual(2030);
    expect(result).toContain('[truncated]');
  });

  it('treats non-strings as empty', () => {
    expect(scrubLogMessage(undefined as never)).toBe('');
  });
});

describe('runtime log buffer bounding', () => {
  it('enforces the byte ceiling', () => {
    const buffer = new RuntimeLogBuffer(1000);
    const now = () => new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 50; i += 1) {
      buffer.append(now, 'info', 'run', `line ${i} ${'y'.repeat(100)}`);
    }
    const { entries, truncated } = buffer.snapshot();
    expect(entries.length).toBeLessThan(50);
    expect(truncated).toBe(true);
  });

  it('keeps the newest entries after bounding', () => {
    const buffer = new RuntimeLogBuffer(100000);
    const now = () => new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 600; i += 1) {
      buffer.append(now, 'info', 'run', `line ${i}`);
    }
    const { entries } = buffer.snapshot();
    expect(entries.length).toBe(500);
    expect(entries[entries.length - 1]?.message).toBe('line 599');
  });

  it('records structured metadata', () => {
    const buffer = new RuntimeLogBuffer(1000);
    const clock = new Date('2026-01-01T00:00:00Z');
    buffer.append(() => clock, 'warning', 'build', 'dependency missing');
    const entry = buffer.snapshot().entries[0];
    expect(entry?.timestamp).toBe(clock.toISOString());
    expect(entry?.level).toBe('warning');
    expect(entry?.phase).toBe('build');
  });
});

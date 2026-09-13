import { describe, expect, it } from 'vitest';
import { failure, formatTimestamp, isOk, safeJsonParse, success } from './index';

describe('Result helpers', () => {
  it('wraps success values', () => {
    const result = success(42);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe(42);
  });

  it('wraps failure values', () => {
    const result = failure(new Error('boom'));
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.message).toBe('boom');
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    const result = safeJsonParse<{ name: string }>('{"name":"Veltravia"}');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.name).toBe('Veltravia');
  });

  it('returns a failure for invalid JSON', () => {
    const result = safeJsonParse('not json');
    expect(isOk(result)).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it('produces an ISO-8601 string ending in Z', () => {
    expect(formatTimestamp(new Date('2026-09-13T12:00:00Z'))).toBe('2026-09-13T12:00:00.000Z');
  });
});

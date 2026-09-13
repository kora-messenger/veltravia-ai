import { describe, expect, it } from 'vitest';
import { readBoolEnv, readEnv, readIntEnv, requireEnv } from './index';

const env = (vars: Record<string, string>) => ({ env: vars });

describe('readEnv', () => {
  it('returns defined values', () => {
    expect(readEnv('API_PORT', env({ API_PORT: '3000' }))).toBe('3000');
  });

  it('treats empty strings as unset', () => {
    expect(readEnv('EMPTY', env({ EMPTY: '' }))).toBeUndefined();
  });
});

describe('requireEnv', () => {
  it('returns the value when present', () => {
    expect(requireEnv('TOKEN', env({ TOKEN: 'abc' }))).toBe('abc');
  });

  it('throws with the variable name when missing', () => {
    expect(() => requireEnv('MISSING', env({}))).toThrow(/MISSING/);
  });
});

describe('readIntEnv', () => {
  it('falls back when unset', () => {
    expect(readIntEnv('PORT', 3000, env({}))).toBe(3000);
  });

  it('parses integers', () => {
    expect(readIntEnv('PORT', 3000, env({ PORT: '8080' }))).toBe(8080);
  });

  it('rejects non-integers', () => {
    expect(() => readIntEnv('PORT', 3000, env({ PORT: 'abc' }))).toThrow(/integer/);
  });
});

describe('readBoolEnv', () => {
  it('accepts common truthy spellings', () => {
    expect(readBoolEnv('FLAG', false, env({ FLAG: 'true' }))).toBe(true);
    expect(readBoolEnv('FLAG', false, env({ FLAG: '1' }))).toBe(true);
    expect(readBoolEnv('FLAG', true, env({ FLAG: 'no' }))).toBe(false);
  });
});

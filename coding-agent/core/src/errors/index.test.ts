import { describe, expect, it } from 'vitest';

import { CodingError, scrubCodingSecrets } from './index.js';

describe('scrubCodingSecrets', () => {
  it.each([
    ['token ghp_abcdefghijklmnopqrstuvwx', /ghp_/],
    ['key github_pat_abcdefghijklmnopqrstuvwx123', /github_pat_/],
    ['value sk-proj-abcdefghijklmnopqrstuvwx', /sk-proj-/],
    ['value sk-abcdefghijklmnopqrst', /sk-[A-Za-z]/],
    ['google AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123', /AIzaSy/],
    ['slack xoxb-1234567890abcdefghij', /xoxb-/],
    ['auth Bearer abcdefghijklmnopqrstu', /Bearer/],
    ['jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig', /eyJhbGciOi/],
    [
      'key -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      /BEGIN RSA PRIVATE KEY/,
    ],
    ['env DATABASE_URL=postgres://user:secret@host/db', /postgres:\/\//],
  ])('scrubs %s', (input, mustNotMatch) => {
    const scrubbed = scrubCodingSecrets(input);
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).not.toMatch(mustNotMatch);
  });
});

describe('CodingError', () => {
  it('scrubs secret-shaped content from the message', () => {
    const error = new CodingError('CODING_INVALID_REQUEST', 'bad input sk-abcdefghijklmnopqrst');
    expect(error.message).not.toMatch(/sk-/);
    expect(error.message).toContain('[REDACTED]');
  });

  it('keeps a stable, regex-able code and serializes safely', () => {
    const error = new CodingError('CODING_INVALID_REQUEST', 'bad input', {
      details: { field: 'x', token: 'ghp_abcdefghijklmnopqrstuvwx' },
    });
    expect(error.code).toBe('CODING_INVALID_REQUEST');
    const json = JSON.stringify(error.toJSON());
    expect(json).not.toMatch(/ghp_/);
    expect(json).toContain('[REDACTED]');
  });
});

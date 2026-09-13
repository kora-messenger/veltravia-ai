import { describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  containsSecretShapedContent,
  isSecretLikeKey,
  isSecretLikeValue,
} from './index.js';

describe('secret-like key detection', () => {
  it('rejects secret-like field names', () => {
    expect(isSecretLikeKey('apiKey')).toBe(true);
    expect(isSecretLikeKey('api_key')).toBe(true);
    expect(isSecretLikeKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretLikeKey('password')).toBe(true);
    expect(isSecretLikeKey('clientSecret')).toBe(true);
    expect(isSecretLikeKey('privateKey')).toBe(true);
    expect(isSecretLikeKey('oauthToken')).toBe(true);
  });

  it('accepts ordinary field names', () => {
    expect(isSecretLikeKey('framework')).toBe(false);
    expect(isSecretLikeKey('buildCommand')).toBe(false);
    expect(isSecretLikeKey('name')).toBe(false);
    expect(isSecretLikeKey('entryPoints')).toBe(false);
  });
});

describe('secret-shaped value detection', () => {
  it('detects real credential shapes regardless of field name', () => {
    expect(isSecretLikeValue('ghp_' + 'a'.repeat(30))).toBe(true);
    expect(isSecretLikeValue('github_pat_' + 'a'.repeat(30))).toBe(true);
    expect(isSecretLikeValue('sk-proj-' + 'a'.repeat(30))).toBe(true);
    expect(isSecretLikeValue('AIzaSy' + 'a'.repeat(20))).toBe(true);
    expect(isSecretLikeValue('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(isSecretLikeValue('Bearer ' + 'a'.repeat(20))).toBe(true);
  });

  it('accepts ordinary values', () => {
    expect(isSecretLikeValue('npm run build')).toBe(false);
    expect(isSecretLikeValue('src/main.tsx')).toBe(false);
    expect(containsSecretShapedContent('just a normal note')).toBe(false);
  });
});

describe('assertNoSecrets', () => {
  it('passes clean metadata', () => {
    expect(() =>
      assertNoSecrets('project metadata', { framework: 'react', count: 3 }),
    ).not.toThrow();
  });

  it('throws and never echoes the secret value back', () => {
    const secret = 'ghp_' + 'b'.repeat(30);
    let message = '';
    try {
      assertNoSecrets('project metadata', { githubToken: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('githubToken');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('ghp_');
  });
});

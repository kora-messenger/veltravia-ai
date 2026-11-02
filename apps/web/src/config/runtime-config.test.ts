import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_CONFIG,
  backendReachable,
  isPackagedApp,
  loadRuntimeConfig,
  normaliseApiBaseUrl,
  runtimeConfig,
  setRuntimeConfig,
} from '../config/runtime-config.js';

/**
 * Where the application looks for its backend (Step 36).
 *
 * A browser build is same-origin and correct by remaining so. A packaged Android
 * application has no same-origin API, so its backend URL is baked in at build
 * time - and that URL is the one thing that decides whether the phone can talk to
 * Veltravia at all. These tests pin the validation, because a silently mangled
 * URL fails on a device where nobody can see a stack trace.
 */
describe('normaliseApiBaseUrl', () => {
  it('accepts an https origin and drops a trailing slash', () => {
    expect(normaliseApiBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normaliseApiBaseUrl('  https://api.example.com  ')).toBe('https://api.example.com');
  });

  it('keeps a path prefix, which a proxied backend legitimately has', () => {
    expect(normaliseApiBaseUrl('https://example.com/veltravia/')).toBe(
      'https://example.com/veltravia',
    );
  });

  it('keeps the port', () => {
    expect(normaliseApiBaseUrl('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('accepts plain http only for loopback', () => {
    expect(normaliseApiBaseUrl('http://localhost:3100')).toBe('http://localhost:3100');
    expect(normaliseApiBaseUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    expect(normaliseApiBaseUrl('http://api.example.com')).toBe('');
  });

  it('refuses anything it cannot use instead of building a broken URL', () => {
    expect(normaliseApiBaseUrl('')).toBe('');
    expect(normaliseApiBaseUrl('   ')).toBe('');
    expect(normaliseApiBaseUrl('api.example.com')).toBe('');
    expect(normaliseApiBaseUrl('not a url')).toBe('');
    expect(normaliseApiBaseUrl('ftp://example.com')).toBe('');
    expect(normaliseApiBaseUrl('https://example.com/?token=secret')).toBe('');
    expect(normaliseApiBaseUrl('https://example.com/#x')).toBe('');
    expect(normaliseApiBaseUrl(undefined)).toBe('');
    expect(normaliseApiBaseUrl(42)).toBe('');
  });
});

describe('loadRuntimeConfig', () => {
  const responseOf = (body: unknown, ok = true) =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response;

  it('reads the configured base URL', async () => {
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    const config = await loadRuntimeConfig((async () =>
      responseOf({ apiBaseUrl: 'https://api.example.com' })) as unknown as typeof fetch);
    expect(config.apiBaseUrl).toBe('https://api.example.com');
    expect(runtimeConfig().apiBaseUrl).toBe('https://api.example.com');
  });

  it('falls back to same-origin when the file is missing', async () => {
    setRuntimeConfig({ apiBaseUrl: 'https://stale.example.com' });
    const config = await loadRuntimeConfig((async () =>
      responseOf({}, false)) as unknown as typeof fetch);
    expect(config.apiBaseUrl).toBe('');
  });

  it('falls back to same-origin when the file is unreadable', async () => {
    const config = await loadRuntimeConfig((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(config.apiBaseUrl).toBe('');
  });

  it('ignores an unusable value rather than trusting it', async () => {
    const config = await loadRuntimeConfig((async () =>
      responseOf({ apiBaseUrl: 'http://evil.example.com' })) as unknown as typeof fetch);
    expect(config.apiBaseUrl).toBe('');
  });
});

describe('packaged application detection', () => {
  it('is not a packaged app in a plain node environment', () => {
    expect(isPackagedApp()).toBe(false);
  });
});

describe('backendReachable', () => {
  it('is true in a browser with no configured URL, because the bundle is served by the API host', () => {
    setRuntimeConfig({ apiBaseUrl: '' });
    expect(backendReachable()).toBe(true);
  });

  it('is true once a URL is configured', () => {
    setRuntimeConfig({ apiBaseUrl: 'https://api.example.com' });
    expect(backendReachable()).toBe(true);
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });
});

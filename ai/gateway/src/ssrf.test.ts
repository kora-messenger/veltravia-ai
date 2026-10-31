import { describe, expect, it } from 'vitest';

import {
  assertSafeEndpoint,
  assertSafeHostname,
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  joinEndpoint,
} from './ssrf/index.js';

const publicResolve = async () => ['93.184.216.34'];

describe('SSRF protection', () => {
  it('accepts a public HTTPS endpoint', async () => {
    const url = await assertSafeEndpoint('https://api.example.com/v1', { resolve: publicResolve });
    expect(url.hostname).toBe('api.example.com');
  });

  it('rejects plain HTTP', async () => {
    await expect(
      assertSafeEndpoint('http://api.example.com/v1', { resolve: publicResolve }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
  });

  it('rejects embedded credentials and fragments', async () => {
    await expect(
      assertSafeEndpoint('https://user:pass@api.example.com/v1', { resolve: publicResolve }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
    await expect(
      assertSafeEndpoint('https://api.example.com/v1#frag', { resolve: publicResolve }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
  });

  it('rejects loopback, private, link-local and metadata hosts', async () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.5',
      '172.16.4.4',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.1.1',
      'metadata.google.internal',
      'service.internal',
      'printer.local',
      '::1',
      '[::1]',
      'fd00::1',
      'fe80::1',
    ]) {
      await expect(
        assertSafeEndpoint(`https://${host}/v1`, { resolve: publicResolve }),
      ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
    }
  });

  it('rejects a public hostname that resolves to a private address (DNS rebinding)', async () => {
    await expect(
      assertSafeEndpoint('https://rebind.example.com/v1', { resolve: async () => ['127.0.0.1'] }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
    await expect(
      assertSafeEndpoint('https://rebind.example.com/v1', {
        resolve: async () => ['93.184.216.34', '169.254.169.254'],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
  });

  it('rejects a hostname that cannot be resolved', async () => {
    await expect(
      assertSafeEndpoint('https://nope.example.com/v1', {
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
  });

  it('classifies address literals', () => {
    expect(isBlockedIpv4('8.8.8.8')).toBe(false);
    expect(isBlockedIpv4('127.0.0.1')).toBe(true);
    expect(isBlockedIpv6('2606:4700::1111')).toBe(false);
    expect(isBlockedIpv6('::1')).toBe(true);
    expect(isBlockedAddress('2001:db8::1')).toBe(true);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('honours deployment deny lists', () => {
    expect(() =>
      assertSafeHostname('internal.veltravia.app', { denyHosts: ['internal.veltravia.app'] }),
    ).toThrow();
  });

  it('refuses absolute paths so a provider path cannot escape its base URL', () => {
    expect(() =>
      joinEndpoint(new URL('https://api.example.com/v1'), 'https://evil.example.com/x'),
    ).toThrow();
    const joined = joinEndpoint(new URL('https://api.example.com/v1'), '/chat/completions');
    expect(joined.toString()).toBe('https://api.example.com/v1/chat/completions');
  });
});

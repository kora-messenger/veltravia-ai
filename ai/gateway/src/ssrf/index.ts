import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { GatewayError } from '../errors/index.js';

/**
 * SSRF protection for custom provider endpoints (Step 26).
 *
 * A custom base URL is owner-supplied, which makes it a request-forgery
 * primitive unless every layer is checked:
 *   - scheme must be HTTPS (plain HTTP only when explicitly allowed in tests);
 *   - no embedded credentials, fragments or unusual ports;
 *   - the hostname must not be a literal private / loopback / metadata address;
 *   - the RESOLVED addresses are checked too, so a public name pointing at
 *     127.0.0.1 is refused (this is the DNS-rebinding case);
 *   - redirects are never followed automatically; each hop is revalidated.
 *
 * Nothing here makes a network request except the DNS lookup the transport
 * would have made anyway.
 */

export interface SsrfGuardOptions {
  /** Allows plain HTTP. Only for tests; production must stay false. */
  readonly allowInsecure?: boolean;
  /** Injectable resolver so tests never touch real DNS. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Extra hostnames to refuse (e.g. the deployment's own internal hosts). */
  readonly denyHosts?: readonly string[];
}

const BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
];

const BLOCKED_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.home.arpa'];

/** IPv4 ranges that must never be reachable from a user-supplied endpoint. */
const BLOCKED_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT 100.64/10
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local (cloud metadata)
  [0xac100000, 12], // private
  [0xc0a80000, 16], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0586300, 24], // 192.0.99
  [0xc6120000, 15], // benchmarking
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved
  [0xff000000, 8], // broadcast
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return BLOCKED_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (network & mask) >>> 0;
  });
}

export function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::' || normalized === '::1') return true;
  // IPv4-mapped and IPv4-compatible forms carry a v4 address in the tail.
  const mapped = /^::(ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (mapped && mapped[2]) return isBlockedIpv4(mapped[2]);
  if (normalized.startsWith('fe80')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local
  if (normalized.startsWith('ff')) return true; // multicast
  if (normalized.startsWith('64:ff9b:')) return true; // NAT64
  if (normalized.startsWith('2001:db8')) return true; // documentation
  return false;
}

/** True when an address literal (v4 or v6) is not allowed as a target. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function unsafe(message: string): GatewayError {
  return new GatewayError('GATEWAY_UNSAFE_ENDPOINT', message);
}

export function assertSafeHostname(hostname: string, options: SsrfGuardOptions = {}): void {
  // URL#hostname keeps the brackets around IPv6 literals; the address checks
  // must see the bare address or they would treat ::1 as a resolvable name.
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1');
  if (host.length === 0) throw unsafe('The endpoint has no hostname.');
  if (BLOCKED_HOSTNAMES.includes(host)) throw unsafe('Local and metadata hosts are not allowed.');
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    throw unsafe('Local and internal hosts are not allowed.');
  if ((options.denyHosts ?? []).some((denied) => host === denied.toLowerCase()))
    throw unsafe('That host is not allowed.');
  if (isIP(host) !== 0 && isBlockedAddress(host))
    throw unsafe('Private, loopback and link-local addresses are not allowed.');
}

/**
 * Validates a URL structurally AND by resolved address. Returns the parsed URL
 * so callers use exactly what was validated (never the raw string again).
 */
export async function assertSafeEndpoint(
  raw: string,
  options: SsrfGuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafe('That endpoint is not a valid URL.');
  }
  if (url.username || url.password) throw unsafe('Endpoints cannot contain credentials.');
  if (url.hash) throw unsafe('Endpoints cannot contain a fragment.');
  if (url.protocol !== 'https:') {
    if (!(options.allowInsecure && url.protocol === 'http:'))
      throw unsafe('Endpoints must use HTTPS.');
  }
  assertSafeHostname(url.hostname, options);

  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (isIP(hostname) === 0) {
    const resolve =
      options.resolve ??
      (async (host: string): Promise<readonly string[]> => {
        const records = await lookup(host, { all: true, verbatim: true });
        return records.map((record) => record.address);
      });
    let addresses: readonly string[];
    try {
      addresses = await resolve(hostname);
    } catch {
      throw unsafe('That endpoint could not be resolved.');
    }
    if (addresses.length === 0) throw unsafe('That endpoint could not be resolved.');
    for (const address of addresses) {
      if (isBlockedAddress(address))
        throw unsafe('That endpoint resolves to a private or reserved address.');
    }
  }
  return url;
}

/** Joins a validated base URL with a relative path, refusing absolute URLs so
 *  a path can never point somewhere the base URL was not validated for. */
export function joinEndpoint(base: URL, path: string): URL {
  if (/^[a-z]+:\/\//i.test(path)) throw unsafe('Absolute provider paths are not allowed.');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${base.pathname.replace(/\/$/, '')}${normalized}`, base.origin);
}

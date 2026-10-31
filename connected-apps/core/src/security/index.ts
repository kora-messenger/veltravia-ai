/** Security helpers for connected-app access: secret-shape rejection (so a
 *  credential can never enter a resource path or an audit record), URL safety
 *  (SSRF), and bounded text hygiene. */

const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\W)(sk-[A-Za-z0-9][A-Za-z0-9_-]{7,})($|\W)/,
  /(^|\W)(gh[pousr]_[A-Za-z0-9]{16,})($|\W)/,
  /(^|\W)(api[_-]?key\s*[:=]\s*\S{8,})/i,
  /(^|\W)(secret\s*[:=]\s*\S{8,})/i,
  /(^|\W)(Bearer\s+[A-Za-z0-9._-]{16,})/,
];

export function looksSecretShaped(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/** Throws when a caller-supplied string looks like a credential. Used for
 *  request inputs so a token can never be smuggled into a stored field or an
 *  audit event. */
export function assertNoSecretShape(value: string, what: string): void {
  if (looksSecretShaped(value))
    throw new Error(`${what} looks like a credential and was rejected.`);
}

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/** SSRF guard for any URL a provider transport is about to fetch: HTTPS only,
 *  no credentials in the URL, no private or loopback hosts. */
export function assertSafeRemoteUrl(raw: string, allowHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Malformed URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed.');
  const host = url.hostname.toLowerCase();
  if (!allowHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))
    throw new Error('Host is not in the provider allowlist.');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host)))
    throw new Error('Private or loopback hosts are not allowed.');
  return url;
}

/** Redacts anything secret-shaped from a string before it is logged. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) =>
      out.replace(pattern, (_m, pre: string, _hit: string, post: string) => {
        return `${pre}[redacted]${post}`;
      }),
    text,
  );
}

export function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Secret hygiene for the provider gateway.
 *
 * Three rules, enforced here so every other module can rely on them:
 *   1. a credential never appears in a value that leaves the gateway;
 *   2. anything secret-shaped is rejected from free-text fields;
 *   3. any string that might be logged is scrubbed first.
 */

/** Vendor key shapes we recognise. Deliberately broad: false positives are
 *  cheap (a rejected description), false negatives are not. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\W)(sk-[A-Za-z0-9][A-Za-z0-9_-]{7,})($|\W)/,
  /(^|\W)(sk-ant-[A-Za-z0-9_-]{8,})($|\W)/,
  /(^|\W)(AIza[0-9A-Za-z_-]{20,})($|\W)/,
  /(^|\W)(gsk_[A-Za-z0-9]{20,})($|\W)/,
  /(^|\W)(xai-[A-Za-z0-9]{10,})($|\W)/,
  /(^|\W)(gh[pousr]_[A-Za-z0-9]{16,})($|\W)/,
  /(^|\W)(api[_-]?key\s*[:=]\s*\S{8,})/i,
  /(^|\W)(secret\s*[:=]\s*\S{8,})/i,
  /(^|\W)(Bearer\s+[A-Za-z0-9._-]{16,})/,
];

export function looksSecretShaped(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/** Redacts anything secret-shaped. Used on provider messages before they are
 *  turned into a normalized error, and on any diagnostic string. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) =>
      out.replace(
        pattern,
        (_match, pre: string, _hit: string, post: string) => `${pre}[redacted]${post}`,
      ),
    text,
  );
}

export function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * A display hint for a credential: the last four characters only, and only
 * when the key is long enough that four characters reveal nothing useful.
 * This is the ONLY credential-derived value that may be stored or displayed.
 */
export function credentialHint(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 12) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** Compares two secrets without leaking length-dependent timing. */
export function safeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * Provider error bodies are untrusted. They are reduced to a category plus a
 * bounded, scrubbed sentence, and are never stored verbatim.
 */
export function summarizeProviderMessage(raw: unknown, max = 240): string {
  const text =
    typeof raw === 'string'
      ? raw
      : raw === undefined || raw === null
        ? ''
        : (() => {
            try {
              return JSON.stringify(raw);
            } catch {
              return '';
            }
          })();
  return bounded(redact(text).replace(/\s+/g, ' ').trim(), max);
}

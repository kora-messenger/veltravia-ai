/**
 * Runtime configuration.
 *
 * The web build carries no environment variables at all: the boundary test in
 * `security/workspace-boundary.test.ts` forbids frontend source from reading the
 * build environment, and a packaged Android application cannot be reconfigured
 * after it is built anyway.
 *
 * Instead a single public JSON file sits next to the bundle. The browser build
 * ships `{"apiBaseUrl": ""}`, which means "same origin, proxied by the web
 * server". The Android build writes its configured backend URL into that file
 * before packaging, so the phone talks to the real backend and never to
 * localhost. Nothing secret ever goes in this file: a base URL is public by
 * definition.
 */

export interface RuntimeConfig {
  /**
   * Absolute base URL of the Veltravia API, with no trailing slash.
   * `''` means same origin.
   */
  readonly apiBaseUrl: string;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = { apiBaseUrl: '' };

/** Where the packaged application expects to find its configuration. */
export const RUNTIME_CONFIG_PATH = '/runtime-config.json';

let current: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;

/** The configuration in force for this page. */
export function runtimeConfig(): RuntimeConfig {
  return current;
}

/** Replaces the configuration (used at startup and by tests). */
export function setRuntimeConfig(next: RuntimeConfig): void {
  current = next;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Validates a configured API base URL.
 *
 * A deployed build must speak https, because the WebView serves the application
 * from a secure origin and because credentials travel on these requests. Plain
 * http is accepted only for a loopback host, which is a developer's own machine.
 * Anything unrecognisable becomes `''` (same origin) rather than a broken URL.
 */
export function normaliseApiBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return '';
  }
  if (url.search.length > 0 || url.hash.length > 0) return '';
  // Keep any path prefix (a backend behind /api-gateway is legitimate) but drop a
  // trailing slash so `base + '/api/...'` never doubles up.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Reads the runtime configuration.
 *
 * A missing file is not an error: same-origin is the correct default for the web
 * application. A file that exists but cannot be understood is also tolerated
 * here, and reported by the caller that needs a different outcome.
 */
export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const response = await fetchImpl(RUNTIME_CONFIG_PATH, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
      return current;
    }
    const body: unknown = await response.json();
    const rawBase =
      typeof body === 'object' && body !== null && 'apiBaseUrl' in body
        ? (body as { apiBaseUrl?: unknown }).apiBaseUrl
        : undefined;
    setRuntimeConfig({ apiBaseUrl: normaliseApiBaseUrl(rawBase) });
    return current;
  } catch {
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    return current;
  }
}

/**
 * True inside the packaged Android application.
 *
 * Capacitor serves the bundle from https://localhost and injects a `Capacitor`
 * global into the WebView; a desktop browser has neither. Nothing here depends on
 * the mobile project, so the web build stays free of native imports.
 */
export function isPackagedApp(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  if (candidate.Capacitor?.isNativePlatform?.() === true) return true;
  return typeof location !== 'undefined' && location.protocol === 'capacitor:';
}

/**
 * Whether this build can reach a backend at all.
 *
 * In a browser the answer is always yes: the bundle is served by something that
 * also proxies /api. Inside the APK there is no same-origin backend, so an empty
 * base URL means the build was packaged without one and every request will fail.
 * Screens use this to say so plainly instead of showing empty lists.
 */
export function backendReachable(): boolean {
  return runtimeConfig().apiBaseUrl.length > 0 || !isPackagedApp();
}

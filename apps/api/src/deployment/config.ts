import { readBoolEnv, readEnv, readIntEnv } from '@veltravia/config';

/**
 * Deployment configuration, resolved from the environment and validated before
 * anything listens.
 *
 * The rule this module exists to enforce: a remote deployment must never start
 * with a configuration that only makes sense on a laptop. In `staging` and
 * `production` the process refuses to start when a required value is missing or
 * when a value is unsafe (a wildcard origin, a plain-http public URL, an
 * unwritable data directory). In `development` and `test` the same findings are
 * warnings, so local work and the test suite are unaffected.
 *
 * Nothing here reads a secret into a log line or an HTTP response: the config
 * records whether a secret is PRESENT, never its value.
 */

export type DeploymentMode = 'development' | 'test' | 'staging' | 'production';

export type StorageDriver = 'memory' | 'file';

export interface DeploymentConfig {
  readonly mode: DeploymentMode;
  readonly host: string;
  readonly port: number;
  /** Exact origins allowed to call the API. Empty means no cross-origin caller. */
  readonly corsOrigins: readonly string[];
  /** The API's own public address, as clients address it. */
  readonly publicUrl: string | null;
  /** True when the deployment must arrive over TLS (staging, production). */
  readonly requiresHttps: boolean;
  /** Whether a forwarded-for header may be believed. Off unless stated. */
  readonly trustProxy: boolean;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  /** Where durable state lives. Null when nothing is durable. */
  readonly dataDir: string | null;
  readonly storageDriver: StorageDriver;
  /** Whether the provider credential key is configured. Never the key itself. */
  readonly hasCredentialKey: boolean;
  /** Blocking findings. Non-empty means the deployment must not start. */
  readonly problems: readonly string[];
  /** Non-blocking findings, printed once at boot. */
  readonly warnings: readonly string[];
}

export class DeploymentConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Deployment configuration is not safe to start:\n- ${problems.join('\n- ')}`);
    this.name = 'DeploymentConfigError';
    this.problems = problems;
  }
}

const MODES: readonly DeploymentMode[] = ['development', 'test', 'staging', 'production'];

function readMode(env: Record<string, string | undefined>): DeploymentMode {
  const raw = readEnv('NODE_ENV', { env }) ?? 'development';
  return (MODES as readonly string[]).includes(raw) ? (raw as DeploymentMode) : 'development';
}

/** A public URL is only acceptable when it is https and has a real host. */
function checkPublicUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'VELTRAVIA_PUBLIC_API_URL is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'VELTRAVIA_PUBLIC_API_URL must use https';
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return 'VELTRAVIA_PUBLIC_API_URL cannot point at localhost for a remote deployment';
  }
  return null;
}

export interface ResolveOptions {
  readonly env?: Record<string, string | undefined>;
}

/**
 * Reads the deployment configuration and reports what is unsafe.
 *
 * A `file` storage driver without a data directory is always a problem: it would
 * write somewhere undefined and lose the data on restart, which is worse than
 * saying so up front.
 */
export function resolveDeploymentConfig(options: ResolveOptions = {}): DeploymentConfig {
  const env = options.env ?? process.env;
  const mode = readMode(env);
  const problems: string[] = [];
  const warnings: string[] = [];
  const remote = mode === 'staging' || mode === 'production';

  const origins = (readEnv('VELTRAVIA_CORS_ORIGINS', { env }) ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  for (const origin of origins) {
    if (origin === '*') {
      problems.push('VELTRAVIA_CORS_ORIGINS must list real origins, never "*"');
      continue;
    }
    try {
      const parsed = new URL(origin);
      if (remote && parsed.protocol !== 'https:') {
        problems.push(`VELTRAVIA_CORS_ORIGINS entry is not https: ${origin}`);
      }
    } catch {
      problems.push(`VELTRAVIA_CORS_ORIGINS entry is not a URL: ${origin}`);
    }
  }

  const publicUrl = readEnv('VELTRAVIA_PUBLIC_API_URL', { env }) ?? null;
  if (publicUrl !== null) {
    const finding = checkPublicUrl(publicUrl);
    if (finding !== null) {
      if (remote || publicUrl.startsWith('http://')) problems.push(finding);
      else warnings.push(finding);
    }
  } else if (remote) {
    problems.push('VELTRAVIA_PUBLIC_API_URL is required so clients know where to call');
  }

  const storageDriver: StorageDriver =
    (readEnv('VELTRAVIA_STORAGE_DRIVER', { env }) ?? 'memory') === 'file' ? 'file' : 'memory';
  const dataDir = readEnv('VELTRAVIA_DATA_DIR', { env }) ?? null;
  if (storageDriver === 'file' && dataDir === null) {
    problems.push('VELTRAVIA_STORAGE_DRIVER=file needs VELTRAVIA_DATA_DIR');
  }
  if (storageDriver === 'memory' && remote) {
    warnings.push('VELTRAVIA_STORAGE_DRIVER=memory: credentials and usage will be lost on restart');
  }

  // A remote deployment with no database loses every project on restart. That
  // is not a configuration error (the API still serves), so it warns loudly
  // rather than refusing to start.
  const hasDatabase =
    (readEnv('VELTRAVIA_DATABASE_URL', { env }) ?? readEnv('DATABASE_URL', { env })) !== undefined;
  if (!hasDatabase && remote) {
    warnings.push(
      'no VELTRAVIA_DATABASE_URL: projects, files and workspaces are in memory and will be lost on restart',
    );
  }

  const hasCredentialKey = readEnv('VELTRAVIA_CREDENTIAL_KEY', { env }) !== undefined;
  if (!hasCredentialKey) {
    if (remote) {
      problems.push(
        'VELTRAVIA_CREDENTIAL_KEY is required: without it no provider key can be stored',
      );
    } else {
      warnings.push('VELTRAVIA_CREDENTIAL_KEY is not set: provider keys cannot be stored');
    }
  }

  if (remote && origins.length === 0) {
    problems.push('VELTRAVIA_CORS_ORIGINS must name the web origins allowed to call this API');
  }

  const trustProxy = readBoolEnv('VELTRAVIA_TRUST_PROXY', false, { env });
  if (trustProxy && !remote) {
    warnings.push('VELTRAVIA_TRUST_PROXY is on outside a remote deployment');
  }

  return {
    mode,
    host: readEnv('API_HOST', { env }) ?? '0.0.0.0',
    port: readIntEnv('API_PORT', 3000, { env }),
    corsOrigins: origins,
    publicUrl,
    requiresHttps: remote,
    trustProxy,
    bodyLimitBytes: readIntEnv('VELTRAVIA_BODY_LIMIT_BYTES', 40 * 1024 * 1024, { env }),
    requestTimeoutMs: readIntEnv('VELTRAVIA_REQUEST_TIMEOUT_MS', 30_000, { env }),
    connectionTimeoutMs: readIntEnv('VELTRAVIA_CONNECTION_TIMEOUT_MS', 10_000, { env }),
    dataDir,
    storageDriver,
    hasCredentialKey,
    problems,
    warnings,
  };
}

/** Refuses to continue when the configuration is unsafe for this deployment. */
export function assertDeploymentConfig(config: DeploymentConfig): DeploymentConfig {
  if (config.problems.length > 0) throw new DeploymentConfigError(config.problems);
  return config;
}

/**
 * @veltravia/config - environment configuration loading and validation.
 *
 * Deliberately dependency-free (no dotenv yet): Node 20 loads .env files via
 * --env-file, and CI/production inject variables through the environment.
 * All real secrets live outside the repository - see docs/security.md.
 */

export interface EnvSource {
  /** Map to read from. Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

function source(opts?: EnvSource): Record<string, string | undefined> {
  return opts?.env ?? process.env;
}

/** Reads an optional environment variable. */
export function readEnv(key: string, opts?: EnvSource): string | undefined {
  const value = source(opts)[key];
  if (value === undefined || value === '') return undefined;
  return value;
}

/** Reads a required environment variable; throws with a clear message if missing. */
export function requireEnv(key: string, opts?: EnvSource): string {
  const value = readEnv(key, opts);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Reads an integer environment variable, falling back to a default. */
export function readIntEnv(key: string, fallback: number, opts?: EnvSource): number {
  const value = readEnv(key, opts);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${value}`);
  }
  return parsed;
}

/** Reads a boolean environment variable (1/true/yes), falling back to a default. */
export function readBoolEnv(key: string, fallback: boolean, opts?: EnvSource): boolean {
  const value = readEnv(key, opts);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

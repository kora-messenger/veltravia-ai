/**
 * Environment isolation.
 *
 * CRITICAL RULE: the sandbox NEVER inherits the API server's environment.
 * There is no code path that reads the host environment in this package (a
 * source-scan test enforces it). The execution environment is built ONLY
 * from the sandbox profile's explicit defaultEnvironment plus the caller's
 * explicit request entries - both validated here.
 *
 * GEMINI_API_KEY, DATABASE_URL, MONGODB_URI, GitHub tokens, OAuth secrets,
 * connector credentials: none of these can appear, because nothing is
 * inherited and explicit secret-shaped values are rejected.
 */

import { EnvironmentRejectedError, InvalidSandboxRequestError } from '../errors/index.js';
import { isSecretLikeValue } from '../secrets/index.js';

/**
 * Environment names that can hijack process loading or shell behavior.
 * They are rejected regardless of value.
 */
const FORBIDDEN_ENV_NAMES: readonly string[] = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FORCE_FLAT_NAMESPACE',
  'BASH_ENV',
  'ENV',
  'PS4',
  'IFS',
  'SHELL',
  'PATH',
  'PYTHONHOME',
  'PERL5OPT',
  'NODE_OPTIONS',
  'RUBYOPT',
  'GEM_HOME',
  'CLASSPATH',
  'JAVA_TOOL_OPTIONS',
  'TMPDIR',
  'HOME',
  'USER',
  'LOGNAME',
  'HOSTNAME',
];

/** Valid explicit environment names: uppercase identifiers. */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_MAX_ENTRIES = 32;
const ENV_VALUE_MAX_LENGTH = 2048;

/**
 * Builds the final isolated environment: profile defaults + request entries.
 * Request entries override profile defaults (both were validated at their
 * own boundary). The host environment is never consulted - not even
 * partially, not even for "safe" variables.
 */
export function buildIsolatedEnvironment(
  defaultEnvironment: Readonly<Record<string, string>>,
  requestEnvironment: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  const entries = [
    ...Object.entries(defaultEnvironment ?? {}),
    ...Object.entries(requestEnvironment ?? {}),
  ];
  if (entries.length > ENV_MAX_ENTRIES) {
    throw new EnvironmentRejectedError(`environment must not exceed ${ENV_MAX_ENTRIES} entries`, {
      reason: 'too-many',
      limit: ENV_MAX_ENTRIES,
    });
  }
  for (const [name, value] of entries) {
    validateEnvironmentEntry(name, value);
    merged[name] = value;
  }
  return merged;
}

/** Validates one explicit environment entry (name + value). */
export function validateEnvironmentEntry(name: string, value: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new EnvironmentRejectedError('environment names must be non-empty strings', {
      reason: 'empty-name',
    });
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new EnvironmentRejectedError('environment name is reserved', {
      reason: 'reserved-name',
    });
  }
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new EnvironmentRejectedError(
      `environment name "${name}" is invalid (uppercase identifiers only)`,
      { reason: 'invalid-name' },
    );
  }
  if (FORBIDDEN_ENV_NAMES.includes(name)) {
    // Loader/hijack/path names - rejected even with innocent values.
    throw new EnvironmentRejectedError(`environment name "${name}" is forbidden`, {
      reason: 'forbidden-name',
    });
  }
  if (typeof value !== 'string') {
    throw new EnvironmentRejectedError(`environment value for "${name}" must be a string`, {
      reason: 'not-a-string',
    });
  }
  if (value.length > ENV_VALUE_MAX_LENGTH) {
    throw new EnvironmentRejectedError(`environment value for "${name}" is too long`, {
      reason: 'too-long',
    });
  }
  if (isSecretLikeValue(value)) {
    throw new EnvironmentRejectedError(
      `environment value for "${name}" is secret-shaped - credentials never enter the sandbox`,
      { reason: 'secret-shaped' },
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the entire point.
  if (/[\x00-\x1f\u007f]/.test(value)) {
    throw new EnvironmentRejectedError(
      `environment value for "${name}" contains control characters`,
      {
        reason: 'control-character',
      },
    );
  }
}

/** Validates the profile's default environment at sandbox-creation time. */
export function validateDefaultEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (environment === undefined) {
    return {};
  }
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    throw new InvalidSandboxRequestError('defaultEnvironment must be an object', {
      reason: 'not-an-object',
    });
  }
  for (const [name, value] of Object.entries(environment)) {
    validateEnvironmentEntry(name, value);
  }
  if (Object.keys(environment).length > ENV_MAX_ENTRIES) {
    throw new EnvironmentRejectedError(
      `defaultEnvironment must not exceed ${ENV_MAX_ENTRIES} entries`,
      { reason: 'too-many', limit: ENV_MAX_ENTRIES },
    );
  }
  return { ...environment };
}

/**
 * Runtime plan validation (Step 17).
 *
 * A plan is accepted only when EVERY command is structured (executable +
 * arguments - shell strings do not exist in the type system and are rejected
 * here too, defensively), the port is in range, limits respect hard ceilings,
 * environment entries are non-secret, and required files are
 * workspace-relative safe paths. Everything is bounded: unlimited values do
 * not exist in the accepted input space.
 */

import { RuntimeEnvironmentRejectedError, RuntimePlanRejectedError } from '../errors/index.js';
import {
  ACTIVE_RUNTIME_TYPES,
  RUNTIME_TYPES,
  type RuntimeCommand,
  type RuntimeLimits,
  type RuntimePlan,
} from '../types/index.js';

/** Hard ceilings - requests above these are rejected, not clipped. */
export const RUNTIME_LIMIT_CEILINGS = Object.freeze({
  buildTimeoutMs: 20 * 60 * 1000,
  startTimeoutMs: 10 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  idleTimeoutMs: 4 * 60 * 60 * 1000,
  maxMemoryMb: 4096,
  maxDiskMb: 10240,
  maxLogBytes: 1024 * 1024,
});

/** Sensible defaults (still under every ceiling). */
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  buildTimeoutMs: 5 * 60 * 1000,
  startTimeoutMs: 60 * 1000,
  maxLifetimeMs: 2 * 60 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
  maxMemoryMb: 1024,
  maxDiskMb: 2048,
  maxLogBytes: 256 * 1024,
});

/** Executables a preview plan may declare. Allowlist-only, path-free. */
export const RUNTIME_ALLOWED_EXECUTABLES = ['npm', 'npx', 'node'] as const;

const SHELL_METACHARACTERS = /[;&|`$><\n\r]/;
const PATH_LIKE = /^\.?\//;
const ARGUMENT_MAX = 512;
const ARGUMENTS_MAX = 64;
const EVIDENCE_MAX = 20;
const ENV_KEYS_MAX = 32;
const REQUIRED_FILES_MAX = 64;

/** Secret-shaped environment VALUES or credential-shaped KEY names. */
export function isSecretShapedValue(value: string): boolean {
  return (
    /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/.test(
      value,
    ) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  );
}

export function isSecretShapedKey(key: string): boolean {
  return /(?:secret|token|password|passwd|credential|api[-_]?key|private[-_]?key|auth)/i.test(key);
}

/** A safe workspace-relative path: no traversal, no absolute, no host refs. */
export function isSafeWorkspacePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) {
    return false;
  }
  if (path.startsWith('/') || PATH_LIKE.test(path)) {
    return false;
  }
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function validateRuntimeCommand(command: RuntimeCommand, field: string): RuntimeCommand {
  if (!command || typeof command !== 'object') {
    throw new RuntimePlanRejectedError(`${field} must be a structured command object`);
  }
  const { executable, arguments: args } = command;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new RuntimePlanRejectedError(`${field}.executable must be a non-empty string`);
  }
  if (
    SHELL_METACHARACTERS.test(executable) ||
    executable.includes('/') ||
    executable.includes('\\')
  ) {
    throw new RuntimePlanRejectedError(
      `${field}.executable must be a bare allowlisted command name (no paths, no shell syntax)`,
      { executable },
    );
  }
  if (!(RUNTIME_ALLOWED_EXECUTABLES as readonly string[]).includes(executable)) {
    throw new RuntimePlanRejectedError(
      `${field}.executable "${executable}" is not in the runtime command allowlist`,
      { executable, allowlist: [...RUNTIME_ALLOWED_EXECUTABLES] },
    );
  }
  if (!Array.isArray(args)) {
    throw new RuntimePlanRejectedError(`${field}.arguments must be an array`);
  }
  if (args.length > ARGUMENTS_MAX) {
    throw new RuntimePlanRejectedError(
      `${field}.arguments exceeds the maximum of ${ARGUMENTS_MAX}`,
    );
  }
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== 'string' || arg.length > ARGUMENT_MAX) {
      throw new RuntimePlanRejectedError(
        `${field}.arguments[${index}] must be a string of at most ${ARGUMENT_MAX} characters`,
      );
    }
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new RuntimePlanRejectedError(
        `${field}.arguments[${index}] contains shell metacharacters - use separate arguments instead`,
      );
    }
  }
  if (command.workingDirectory !== undefined) {
    if (!isSafeWorkspacePath(command.workingDirectory)) {
      throw new RuntimePlanRejectedError(
        `${field}.workingDirectory must be a safe workspace-relative path`,
      );
    }
  }
  return command;
}

export function validateRuntimeEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!environment || typeof environment !== 'object') {
    throw new RuntimePlanRejectedError('environment must be an object');
  }
  const keys = Object.keys(environment);
  if (keys.length > ENV_KEYS_MAX) {
    throw new RuntimePlanRejectedError(`environment exceeds ${ENV_KEYS_MAX} entries`);
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
      throw new RuntimePlanRejectedError('environment keys must be 1-64 characters');
    }
    if (isSecretShapedKey(key)) {
      throw new RuntimeEnvironmentRejectedError(key);
    }
    const value = environment[key];
    if (typeof value !== 'string') {
      throw new RuntimePlanRejectedError(`environment.${key} must be a string`);
    }
    if (value.length > 1024) {
      throw new RuntimePlanRejectedError(`environment.${key} exceeds 1024 characters`);
    }
    if (isSecretShapedValue(value)) {
      throw new RuntimeEnvironmentRejectedError(key);
    }
  }
  return environment;
}

export function validateRuntimeLimits(limits: RuntimeLimits): RuntimeLimits {
  if (!limits || typeof limits !== 'object') {
    throw new RuntimePlanRejectedError('limits must be an object');
  }
  const ceilings = RUNTIME_LIMIT_CEILINGS;
  for (const key of Object.keys(ceilings) as (keyof RuntimeLimits)[]) {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new RuntimePlanRejectedError(`limits.${key} must be a positive integer`);
    }
    if (value > ceilings[key]) {
      throw new RuntimePlanRejectedError(
        `limits.${key} exceeds the hard ceiling of ${ceilings[key]}`,
        { field: key, requested: value, ceiling: ceilings[key] },
      );
    }
  }
  if (limits.idleTimeoutMs > limits.maxLifetimeMs) {
    throw new RuntimePlanRejectedError('limits.idleTimeoutMs cannot exceed limits.maxLifetimeMs');
  }
  return limits;
}

/** Validate a complete runtime plan. Rejects unlimited/oversized anything. */
export function validateRuntimePlan(plan: RuntimePlan): RuntimePlan {
  if (!plan || typeof plan !== 'object') {
    throw new RuntimePlanRejectedError('plan must be an object');
  }
  if (!RUNTIME_TYPES.includes(plan.runtimeType)) {
    throw new RuntimePlanRejectedError(`unknown runtime type "${String(plan.runtimeType)}"`);
  }
  if (!ACTIVE_RUNTIME_TYPES.includes(plan.runtimeType)) {
    throw new RuntimePlanRejectedError(
      `runtime type "${plan.runtimeType}" is declared but not active yet`,
      { requested: plan.runtimeType, active: [...ACTIVE_RUNTIME_TYPES] },
    );
  }
  if (typeof plan.projectId !== 'string' || plan.projectId.length === 0) {
    throw new RuntimePlanRejectedError('plan.projectId is required');
  }
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.length === 0) {
    throw new RuntimePlanRejectedError('plan.workspaceId is required');
  }
  if (!Number.isInteger(plan.expectedRevision) || plan.expectedRevision < 0) {
    throw new RuntimePlanRejectedError('plan.expectedRevision must be a non-negative integer');
  }
  if (!Array.isArray(plan.requiredFiles) || plan.requiredFiles.length > REQUIRED_FILES_MAX) {
    throw new RuntimePlanRejectedError(
      `plan.requiredFiles must be an array of at most ${REQUIRED_FILES_MAX} paths`,
    );
  }
  for (const path of plan.requiredFiles) {
    if (!isSafeWorkspacePath(path)) {
      throw new RuntimePlanRejectedError(`plan.requiredFiles contains an unsafe path: "${path}"`);
    }
  }
  if (plan.buildCommand !== null) {
    validateRuntimeCommand(plan.buildCommand, 'buildCommand');
  }
  validateRuntimeCommand(plan.startCommand, 'startCommand');
  if (!Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535) {
    throw new RuntimePlanRejectedError('plan.port must be an integer between 1024 and 65535');
  }
  validateRuntimeEnvironment(plan.environment);
  const { healthCheck } = plan;
  if (!healthCheck || typeof healthCheck !== 'object') {
    throw new RuntimePlanRejectedError('plan.healthCheck is required');
  }
  if (typeof healthCheck.path !== 'string' || !healthCheck.path.startsWith('/')) {
    throw new RuntimePlanRejectedError('plan.healthCheck.path must start with "/"');
  }
  if (healthCheck.path.length > 256) {
    throw new RuntimePlanRejectedError('plan.healthCheck.path exceeds 256 characters');
  }
  if (
    !Number.isInteger(healthCheck.intervalMs) ||
    healthCheck.intervalMs <= 0 ||
    healthCheck.intervalMs > 60000
  ) {
    throw new RuntimePlanRejectedError('plan.healthCheck.intervalMs must be 1-60000ms');
  }
  if (
    !Number.isInteger(healthCheck.timeoutMs) ||
    healthCheck.timeoutMs <= 0 ||
    healthCheck.timeoutMs > 60000
  ) {
    throw new RuntimePlanRejectedError('plan.healthCheck.timeoutMs must be 1-60000ms');
  }
  if (
    !Number.isInteger(healthCheck.maxChecks) ||
    healthCheck.maxChecks <= 0 ||
    healthCheck.maxChecks > 30
  ) {
    throw new RuntimePlanRejectedError('plan.healthCheck.maxChecks must be 1-30');
  }
  validateRuntimeLimits(plan.limits);
  if (!Array.isArray(plan.evidence) || plan.evidence.length > EVIDENCE_MAX) {
    throw new RuntimePlanRejectedError(
      `plan.evidence must be an array of at most ${EVIDENCE_MAX} lines`,
    );
  }
  for (const line of plan.evidence) {
    if (typeof line !== 'string' || line.length > 300) {
      throw new RuntimePlanRejectedError(
        'plan.evidence lines must be strings of at most 300 characters',
      );
    }
  }
  return plan;
}

/**
 * Structured-command equivalence - a request matches a plan's command only
 * when executable AND arguments are identical. Used to prevent an
 * unauthorized command from riding an approved runtime.
 */
export function commandsEqual(a: RuntimeCommand | null, b: RuntimeCommand | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.executable === b.executable &&
    a.arguments.length === b.arguments.length &&
    a.arguments.every((value, index) => value === b.arguments[index])
  );
}

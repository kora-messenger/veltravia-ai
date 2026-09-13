/**
 * Resource limit validation - every execution carries explicit, bounded
 * limits. Zero, negative, non-integer, and absurdly large values are
 * REJECTED (never clamped silently). Safe defaults exist so callers can
 * omit limits, but the runtime NEVER sees a request without resolved
 * values.
 */

import { InvalidSandboxRequestError, LimitsRejectedError } from '../errors/index.js';
import type { ResourceLimits, ResourceLimitOverrides } from '../types/index.js';

/** Safe defaults for every limit. */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 30_000,
  maxMemoryMb: 256,
  maxCpuTimeMs: 10_000,
  maxOutputBytes: 262_144,
  maxProcesses: 16,
  maxFileBytes: 8_388_608,
});

/**
 * Hard ceilings. Values above these are "absurdly large" and rejected.
 * No configuration - manager options, profile defaults, or request
 * overrides - can exceed them.
 */
export const RESOURCE_LIMIT_CEILINGS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 600_000,
  maxMemoryMb: 2_048,
  maxCpuTimeMs: 600_000,
  maxOutputBytes: 10_485_760,
  maxProcesses: 64,
  maxFileBytes: 134_217_728,
});

/** Validates a single limit value against its floor and ceiling. */
function validateLimitValue(field: keyof ResourceLimits, value: number): number {
  if (!Number.isInteger(value)) {
    throw new LimitsRejectedError(`${field} must be an integer`, {
      field,
      reason: 'not-an-integer',
    });
  }
  if (value <= 0) {
    throw new LimitsRejectedError(`${field} must be positive (zero and negative values are rejected)`, {
      field,
      reason: 'non-positive',
    });
  }
  const ceiling = RESOURCE_LIMIT_CEILINGS[field];
  if (value > ceiling) {
    throw new LimitsRejectedError(`${field} exceeds the hard ceiling of ${ceiling}`, {
      field,
      reason: 'above-ceiling',
      ceiling,
    });
  }
  return value;
}

/** Validates a complete limits object (e.g. a profile's defaultLimits). */
export function validateResourceLimits(
  limits: Partial<ResourceLimits>,
  context: string,
): ResourceLimits {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new InvalidSandboxRequestError(`${context} must be an object`, { reason: 'not-an-object' });
  }
  if (limits.timeoutMs === undefined) throw missing('timeoutMs');
  if (limits.maxMemoryMb === undefined) throw missing('maxMemoryMb');
  if (limits.maxCpuTimeMs === undefined) throw missing('maxCpuTimeMs');
  if (limits.maxOutputBytes === undefined) throw missing('maxOutputBytes');
  if (limits.maxProcesses === undefined) throw missing('maxProcesses');
  if (limits.maxFileBytes === undefined) throw missing('maxFileBytes');
  return {
    timeoutMs: validateLimitValue('timeoutMs', limits.timeoutMs),
    maxMemoryMb: validateLimitValue('maxMemoryMb', limits.maxMemoryMb),
    maxCpuTimeMs: validateLimitValue('maxCpuTimeMs', limits.maxCpuTimeMs),
    maxOutputBytes: validateLimitValue('maxOutputBytes', limits.maxOutputBytes),
    maxProcesses: validateLimitValue('maxProcesses', limits.maxProcesses),
    maxFileBytes: validateLimitValue('maxFileBytes', limits.maxFileBytes),
  };
}

function missing(field: string): LimitsRejectedError {
  return new LimitsRejectedError(`limits are missing mandatory field "${field}"`, {
    field,
    reason: 'missing',
  });
}

/**
 * Resolves the effective limits for one execution: profile defaults filled
 * with caller overrides, every value (default AND override) re-validated
 * against floors and ceilings. The result is always complete and bounded.
 */
export function resolveExecutionLimits(
  defaultLimits: ResourceLimits,
  overrides: ResourceLimitOverrides | undefined,
): ResourceLimits {
  if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null)) {
    throw new InvalidSandboxRequestError('limits must be an object', { reason: 'not-an-object' });
  }
  const resolve = (field: keyof ResourceLimits): number => {
    const fallback = validateLimitValue(field, defaultLimits[field]);
    const override = overrides?.[field];
    return override === undefined ? fallback : validateLimitValue(field, override);
  };
  return {
    timeoutMs: resolve('timeoutMs'),
    maxMemoryMb: resolve('maxMemoryMb'),
    maxCpuTimeMs: resolve('maxCpuTimeMs'),
    maxOutputBytes: resolve('maxOutputBytes'),
    maxProcesses: resolve('maxProcesses'),
    maxFileBytes: resolve('maxFileBytes'),
  };
}

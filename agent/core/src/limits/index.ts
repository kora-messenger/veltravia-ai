import { InvalidAgentLimitsError } from '../errors/index.js';

/**
 * Agent execution limits - every loop is bounded. There is NO "unlimited":
 * callers may only LOWER the platform defaults, never raise them above the
 * hard ceilings, and the agent cannot change its own limits at runtime.
 */

/** Hard ceilings - no caller, and no agent, may exceed these. */
export const AGENT_LIMIT_CEILINGS = {
  maxIterations: 50,
  maxToolCalls: 50,
  maxDurationMs: 10 * 60 * 1000, // 10 minutes
  maxConsecutiveFailures: 10,
  maxOutputTokens: 32_768,
} as const;

/** Safe defaults used whenever the caller does not set a limit. */
export const DEFAULT_AGENT_EXECUTION_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 8,
  maxDurationMs: 60 * 1000, // 1 minute
  maxConsecutiveFailures: 3,
} as const;

/** Caller-settable limit fields. `maxOutputTokens` is optional (0 = unset). */
export interface AgentExecutionLimits {
  /** Maximum loop iterations (decisions) for the run. Default 8, ceiling 50. */
  readonly maxIterations: number;
  /** Maximum tool invocations for the run. Default 8, ceiling 50. */
  readonly maxToolCalls: number;
  /** Maximum wall-clock execution (ms). Default 60 000, ceiling 600 000. */
  readonly maxDurationMs: number;
  /** Maximum consecutive failures (bad decisions or failed/denied tool results). Default 3, ceiling 10. */
  readonly maxConsecutiveFailures: number;
  /** Optional per-decision output token budget, where the AI abstraction supports it. 0 = unset. */
  readonly maxOutputTokens: number;
}

export interface AgentExecutionLimitsInput {
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
  readonly maxDurationMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxOutputTokens?: number;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Resolves caller input into effective limits: defaults filled in, every
 * value validated, and hard ceilings enforced. Callers can never raise a
 * limit above the ceiling (the value is capped, silently and safely).
 */
export function resolveAgentExecutionLimits(
  input: AgentExecutionLimitsInput = {},
): AgentExecutionLimits {
  const reasons: string[] = [];
  const check = (
    value: number | undefined,
    name: string,
    floor: number,
    ceiling: number,
    integer = true,
  ): number | undefined => {
    if (value === undefined) return undefined;
    const valid = integer ? isPositiveInteger(value) : isNonNegativeInteger(value);
    if (!valid || value < floor) {
      reasons.push(`${name} must be an integer >= ${floor}`);
      return undefined;
    }
    return Math.min(value, ceiling);
  };

  const maxIterations = check(
    input.maxIterations,
    'maxIterations',
    1,
    AGENT_LIMIT_CEILINGS.maxIterations,
  );
  const maxToolCalls = check(
    input.maxToolCalls,
    'maxToolCalls',
    1,
    AGENT_LIMIT_CEILINGS.maxToolCalls,
  );
  const maxDurationMs = check(
    input.maxDurationMs,
    'maxDurationMs',
    1,
    AGENT_LIMIT_CEILINGS.maxDurationMs,
  );
  const maxConsecutiveFailures = check(
    input.maxConsecutiveFailures,
    'maxConsecutiveFailures',
    1,
    AGENT_LIMIT_CEILINGS.maxConsecutiveFailures,
  );
  const maxOutputTokens = check(
    input.maxOutputTokens,
    'maxOutputTokens',
    0,
    AGENT_LIMIT_CEILINGS.maxOutputTokens,
  );

  if (reasons.length > 0) {
    throw new InvalidAgentLimitsError(reasons);
  }

  return {
    maxIterations: maxIterations ?? DEFAULT_AGENT_EXECUTION_LIMITS.maxIterations,
    maxToolCalls: maxToolCalls ?? DEFAULT_AGENT_EXECUTION_LIMITS.maxToolCalls,
    maxDurationMs: maxDurationMs ?? DEFAULT_AGENT_EXECUTION_LIMITS.maxDurationMs,
    maxConsecutiveFailures:
      maxConsecutiveFailures ?? DEFAULT_AGENT_EXECUTION_LIMITS.maxConsecutiveFailures,
    maxOutputTokens: maxOutputTokens ?? 0,
  };
}

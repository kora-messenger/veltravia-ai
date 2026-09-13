import { describe, expect, it } from 'vitest';
import { InvalidAgentLimitsError } from '../errors/index.js';
import {
  AGENT_LIMIT_CEILINGS,
  DEFAULT_AGENT_EXECUTION_LIMITS,
  resolveAgentExecutionLimits,
} from './index.js';

describe('resolveAgentExecutionLimits', () => {
  it('fills in safe defaults', () => {
    const limits = resolveAgentExecutionLimits();
    expect(limits).toEqual({
      maxIterations: DEFAULT_AGENT_EXECUTION_LIMITS.maxIterations,
      maxToolCalls: DEFAULT_AGENT_EXECUTION_LIMITS.maxToolCalls,
      maxDurationMs: DEFAULT_AGENT_EXECUTION_LIMITS.maxDurationMs,
      maxConsecutiveFailures: DEFAULT_AGENT_EXECUTION_LIMITS.maxConsecutiveFailures,
      maxOutputTokens: 0,
    });
  });

  it('accepts valid caller limits', () => {
    const limits = resolveAgentExecutionLimits({
      maxIterations: 3,
      maxToolCalls: 2,
      maxDurationMs: 5000,
    });
    expect(limits.maxIterations).toBe(3);
    expect(limits.maxToolCalls).toBe(2);
    expect(limits.maxDurationMs).toBe(5000);
  });

  it('rejects zero, negative, fractional, and non-numeric values - there is no unlimited', () => {
    expect(() => resolveAgentExecutionLimits({ maxIterations: 0 })).toThrow(
      InvalidAgentLimitsError,
    );
    expect(() => resolveAgentExecutionLimits({ maxIterations: -5 })).toThrow(
      InvalidAgentLimitsError,
    );
    expect(() => resolveAgentExecutionLimits({ maxIterations: Number.POSITIVE_INFINITY })).toThrow(
      InvalidAgentLimitsError,
    );
    expect(() => resolveAgentExecutionLimits({ maxIterations: 2.5 })).toThrow(
      InvalidAgentLimitsError,
    );
    expect(() => resolveAgentExecutionLimits({ maxToolCalls: 0 })).toThrow(InvalidAgentLimitsError);
    expect(() => resolveAgentExecutionLimits({ maxDurationMs: 0 })).toThrow(
      InvalidAgentLimitsError,
    );
    expect(() => resolveAgentExecutionLimits({ maxConsecutiveFailures: 0 })).toThrow(
      InvalidAgentLimitsError,
    );
  });

  it('caps caller limits at the hard ceilings - callers can never exceed them', () => {
    const limits = resolveAgentExecutionLimits({
      maxIterations: 100_000,
      maxToolCalls: 1_000_000,
      maxDurationMs: 24 * 60 * 60 * 1000,
      maxConsecutiveFailures: 999,
      maxOutputTokens: 1_000_000,
    });
    expect(limits.maxIterations).toBe(AGENT_LIMIT_CEILINGS.maxIterations);
    expect(limits.maxToolCalls).toBe(AGENT_LIMIT_CEILINGS.maxToolCalls);
    expect(limits.maxDurationMs).toBe(AGENT_LIMIT_CEILINGS.maxDurationMs);
    expect(limits.maxConsecutiveFailures).toBe(AGENT_LIMIT_CEILINGS.maxConsecutiveFailures);
    expect(limits.maxOutputTokens).toBe(AGENT_LIMIT_CEILINGS.maxOutputTokens);
  });
});

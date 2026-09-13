/**
 * Sandbox + execution lifecycle state machines.
 *
 * Every transition is validated; illegal transitions throw. Destroyed is
 * terminal; expired is a one-way freeze; a cancelled execution is terminal
 * and can never resume.
 */

import { InvalidSandboxTransitionError } from '../errors/index.js';
import type { ExecutionStatus, SandboxStatus } from '../types/index.js';

/** Valid sandbox transitions. Keys with empty maps are terminal-ish (destroyed). */
export const SANDBOX_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> =
  Object.freeze({
    creating: ['ready', 'failed', 'destroyed'],
    ready: ['running', 'stopping', 'expired', 'destroyed'],
    running: ['ready', 'stopping', 'expired', 'failed', 'destroyed'],
    stopping: ['stopped', 'expired', 'destroyed'],
    stopped: ['destroyed'],
    failed: ['destroyed'],
    expired: ['destroyed'],
    destroyed: [],
  });

/** Valid execution transitions. Everything terminal is one-way. */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> =
  Object.freeze({
    running: ['stopping', 'completed', 'failed', 'timed_out', 'terminated', 'cancelled'],
    stopping: ['cancelled'],
    completed: [],
    failed: [],
    timed_out: [],
    terminated: [],
    cancelled: [],
  });

export function assertSandboxTransition(from: SandboxStatus, to: SandboxStatus): void {
  const allowed = SANDBOX_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidSandboxTransitionError(from, to);
  }
}

export function canTransitionSandbox(from: SandboxStatus, to: SandboxStatus): boolean {
  const allowed = SANDBOX_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  const allowed = EXECUTION_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidSandboxTransitionError(`execution:${from}`, `execution:${to}`);
  }
}

/** Sandbox statuses from which a new execution may start. */
export function isSandboxExecutable(status: SandboxStatus): boolean {
  return status === 'ready';
}

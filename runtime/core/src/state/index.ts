/**
 * Runtime lifecycle state machine (Step 17).
 *
 * Explicit, validated transitions - an illegal transition throws instead of
 * silently reshaping state. Terminal states are terminal: a stopped/expired/
 * cancelled/failed runtime can never run again (a restart creates a NEW
 * runtime bound to the LATEST revision).
 */

import { RuntimeInvalidTransitionError } from '../errors/index.js';
import type { RuntimeStatus } from '../types/index.js';

/** Legal transitions. Anything absent is rejected. */
const TRANSITIONS: Readonly<Record<RuntimeStatus, readonly RuntimeStatus[]>> = Object.freeze({
  created: ['preparing', 'cancelled'],
  preparing: ['building', 'starting', 'failed', 'cancelled'],
  building: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['stopping', 'failed', 'expired', 'cancelled'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: [],
  expired: [],
  cancelled: [],
});

/** Terminal states - no outgoing transitions exist. */
export const TERMINAL_RUNTIME_STATES: readonly RuntimeStatus[] = [
  'stopped',
  'failed',
  'expired',
  'cancelled',
];

export function isTerminalRuntimeStatus(status: RuntimeStatus): boolean {
  return TERMINAL_RUNTIME_STATES.includes(status);
}

export function assertRuntimeTransition(from: RuntimeStatus, to: RuntimeStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new RuntimeInvalidTransitionError(from, to);
  }
}

export function canTransition(from: RuntimeStatus, to: RuntimeStatus): boolean {
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** States in which the runtime is considered "live" (owns a preview slot). */
export function isLiveRuntimeStatus(status: RuntimeStatus): boolean {
  return (
    status === 'preparing' || status === 'building' || status === 'starting' || status === 'running'
  );
}

/**
 * Index build state machine (Phase 27).
 *
 * Explicit, validated transitions. `cancelled` and `failed` are one-way:
 * a cancelled build never silently completes, and a failed build never
 * pretends to be current. A failed FILE never fails the whole build; only
 * a genuinely fatal build-level error produces `failed`.
 */

import { CODEBASE_INDEX_BUILD_STATES, type CodebaseIndexBuildState } from '../types/index.js';

const TRANSITIONS: Readonly<Record<CodebaseIndexBuildState, readonly CodebaseIndexBuildState[]>> = {
  created: ['scanning', 'cancelled', 'failed'],
  scanning: ['parsing', 'cancelled', 'failed'],
  parsing: ['resolving', 'cancelled', 'failed'],
  resolving: ['building_relationships', 'cancelled', 'failed'],
  building_relationships: ['completed', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isCodebaseIndexBuildState(value: unknown): value is CodebaseIndexBuildState {
  return (
    typeof value === 'string' && (CODEBASE_INDEX_BUILD_STATES as readonly string[]).includes(value)
  );
}

export function canTransition(from: CodebaseIndexBuildState, to: CodebaseIndexBuildState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CodebaseIndexBuildState, to: CodebaseIndexBuildState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid index build transition: ${from} -> ${to}`);
  }
}

/** True for the states a build can still move forward from. */
export function isActiveBuildState(state: CodebaseIndexBuildState): boolean {
  return state !== 'completed' && state !== 'failed' && state !== 'cancelled';
}

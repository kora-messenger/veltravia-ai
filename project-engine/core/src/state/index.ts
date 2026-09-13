/**
 * Controlled status transitions for projects and workspaces.
 *
 * Terminal statuses never transition again; illegal transitions throw typed
 * errors instead of silently coercing.
 */

import { type ProjectStatus, type WorkspaceStatus } from '../types/index.js';
import { ProjectTransitionError } from '../errors/index.js';

/**
 * Project transitions:
 *   active  -> archived (archive)
 *   archived -> active  (restore)
 *   active  -> deleted  (soft delete)
 *   archived -> deleted (soft delete)
 *   deleted is TERMINAL - `deleted -> active` is rejected.
 */
export const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  active: ['archived', 'deleted'],
  archived: ['active', 'deleted'],
  deleted: [],
};

/**
 * Workspace transitions:
 *   active  -> locked   (lock)
 *   locked  -> active   (unlock)
 *   active  -> archived (archive)
 *   locked  -> archived (archive)
 *   archived -> active  (restore)
 */
export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceStatus, readonly WorkspaceStatus[]>> =
  {
    active: ['locked', 'archived'],
    locked: ['active', 'archived'],
    archived: ['active'],
  };

/** Asserts that a project transition is legal; throws `ProjectTransitionError` otherwise. */
export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (from === to) {
    throw new ProjectTransitionError(from, `${to} (no-op transition)`);
  }
  const allowed = PROJECT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ProjectTransitionError(from, to);
  }
}

/** True when a project transition is legal. */
export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return from !== to && PROJECT_TRANSITIONS[from].includes(to);
}

/** Asserts that a workspace transition is legal; throws `ProjectTransitionError` otherwise. */
export function assertWorkspaceTransition(from: WorkspaceStatus, to: WorkspaceStatus): void {
  if (from === to) {
    throw new ProjectTransitionError(from, `${to} (no-op transition)`);
  }
  const allowed = WORKSPACE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ProjectTransitionError(from, to);
  }
}

/** True when a workspace transition is legal. */
export function canTransitionWorkspace(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
  return from !== to && WORKSPACE_TRANSITIONS[from].includes(to);
}

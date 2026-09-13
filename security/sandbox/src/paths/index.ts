/**
 * Workspace-relative path validation for the sandbox.
 *
 * The sandbox NEVER receives host paths. The only path a caller may choose
 * is the working directory, expressed relative to the sandbox's assigned
 * workspace. Everything else - /etc, /home, /root, /proc, /sys, /dev,
 * Windows drives - is rejected with typed errors that never echo raw input
 * beyond a bounded, safe reason.
 */

import { InvalidSandboxRequestError } from '../errors/index.js';

const ROOT_PATH = '';
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 32;
/* eslint-disable no-control-regex -- rejecting control characters is the entire
   point of this pattern. */
const CONTROL_PATTERN = /[\x00-\x1f\u007f]/;
/* eslint-enable no-control-regex */
/** Rejection reasons - coded so callers/tests can assert precisely. */
export type PathRejectReason =
  | 'empty'
  | 'not-a-string'
  | 'too-long'
  | 'too-deep'
  | 'control-character'
  | 'absolute-path'
  | 'windows-path'
  | 'traversal-segment'
  | 'empty-segment'
  | 'dot-segment';

/** Validates and normalizes a workspace-relative path. Throws on violation. */
export function normalizeWorkspaceRelativePath(input: string, field: string): string {
  if (typeof input !== 'string') {
    throw new InvalidSandboxRequestError(`${field} must be a string`, { field, reason: 'not-a-string' });
  }
  const path = input.trim();
  if (path === ROOT_PATH || path === '.') {
    return ROOT_PATH;
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new InvalidSandboxRequestError(`${field} is too long`, { field, reason: 'too-long' });
  }
  if (CONTROL_PATTERN.test(path)) {
    throw new InvalidSandboxRequestError(`${field} contains control characters`, {
      field,
      reason: 'control-character',
    });
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new InvalidSandboxRequestError(`${field} must be workspace-relative (absolute host paths are rejected)`, {
      field,
      reason: 'absolute-path',
    });
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    throw new InvalidSandboxRequestError(`${field} must be workspace-relative (Windows paths are rejected)`, {
      field,
      reason: 'windows-path',
    });
  }
  if (path.includes('\\')) {
    throw new InvalidSandboxRequestError(`${field} must use forward slashes only`, {
      field,
      reason: 'windows-path',
    });
  }
  const segments = path.split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '') {
      throw new InvalidSandboxRequestError(`${field} has an empty segment`, {
        field,
        reason: 'empty-segment',
      });
    }
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new InvalidSandboxRequestError(`${field} must not contain ".." traversal segments`, {
        field,
        reason: 'traversal-segment',
      });
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    return ROOT_PATH;
  }
  if (normalized.length > MAX_PATH_DEPTH) {
    throw new InvalidSandboxRequestError(`${field} is nested too deeply`, {
      field,
      reason: 'too-deep',
    });
  }
  return normalized.join('/');
}

/** Non-throwing variant for tests and non-path fields. */
export function isWorkspaceRelativePath(input: string): boolean {
  try {
    normalizeWorkspaceRelativePath(input, 'path');
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates an opaque workspace reference (a Project Engine workspace id).
 * It must be a plain identifier - never a path, never a URL, never a host
 * location. Cross-workspace access is impossible by construction: the
 * reference is pinned at sandbox creation and never appears in execution
 * requests.
 */
export function validateWorkspaceRef(workspaceRef: string): string {
  if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) {
    throw new InvalidSandboxRequestError('workspaceRef must be a non-empty string', {
      reason: 'empty',
    });
  }
  if (workspaceRef.length > 128) {
    throw new InvalidSandboxRequestError('workspaceRef is too long', { reason: 'too-long' });
  }
  if (!/^[\w][\w.-]*$/.test(workspaceRef)) {
    throw new InvalidSandboxRequestError(
      'workspaceRef must be an opaque identifier (paths and URLs are rejected)',
      { reason: 'path-like' },
    );
  }
  return workspaceRef;
}

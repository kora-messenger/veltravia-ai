/**
 * Project Engine errors - stable, typed, and scrubbed.
 *
 * Every error message and detail is scrubbed of secret-shaped content, so a
 * rejected secret can never leak back through an error surface.
 */

/** Options for project errors: safe details + error cause. */
export interface ProjectErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Project Engine error codes - stable, typed, and regex-able in tests.
 */
export const PROJECT_ERROR_CODES = [
  'PROJECT_INVALID_REQUEST',
  'PROJECT_NOT_FOUND',
  'PROJECT_INVALID_TRANSITION',
  'PROJECT_DELETED',
  'PROJECT_ARCHIVED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_ACTIVE',
  'FILE_NOT_FOUND',
  'PATH_INVALID',
  'PATH_CONFLICT',
  'PATH_PARENT_MISSING',
  'NODE_INVALID',
  'REVISION_CONFLICT',
  'SECRET_REJECTED',
  'CONTEXT_INVALID',
  'CONFIG_INVALID',
  'INTEGRATION_INVALID',
] as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

/** Secret-shaped patterns scrubbed from EVERY project-engine error surface. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /eyJhbGciOi[A-Za-z0-9._-]{20,}/g,
  /(?:api[_-]?key|secret|password|token|credential)s?\s*[:=]\s*\S+/gi,
];

/** Scrubs secret-shaped substrings from a string (used for ALL error surfaces). */
export function scrubProjectSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
}

/** Scrubs secret-shaped values from arbitrary JSON metadata (deep copy). */
export function scrubProjectMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubProjectSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[scrubProjectSecrets(key)] = walk(inner);
      return out;
    }
    return value;
  };
  return walk(metadata) as Record<string, unknown>;
}

/** Base class for every Project Engine error. Secrets are scrubbed from messages + details. */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ProjectErrorCode, message: string, options?: ProjectErrorOptions) {
    super(scrubProjectSecrets(message), options);
    this.name = 'ProjectError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = scrubProjectMetadata(options.details) as Record<string, unknown>;
    }
  }

  /** Structured, stack-free representation for API surfaces. */
  toJSON(): { code: ProjectErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Type guard for Project Engine errors. */
export function isProjectError(error: unknown): error is ProjectError {
  return error instanceof ProjectError;
}

export class InvalidProjectRequestError extends ProjectError {
  constructor(reasons: readonly string[]) {
    super('PROJECT_INVALID_REQUEST', `Invalid project request: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'InvalidProjectRequestError';
  }
}

export class ProjectNotFoundError extends ProjectError {
  constructor(projectId: string) {
    super('PROJECT_NOT_FOUND', `No project found with id "${projectId}".`, {
      details: { projectId },
    });
    this.name = 'ProjectNotFoundError';
  }
}

/** An illegal status transition (e.g. `deleted -> active`) was attempted. */
export class ProjectTransitionError extends ProjectError {
  constructor(from: string, to: string) {
    super('PROJECT_INVALID_TRANSITION', `Invalid project transition: ${from} -> ${to}.`, {
      details: { from, to },
    });
    this.name = 'ProjectTransitionError';
  }
}

/** The project is soft-deleted; every mutating operation is rejected. */
export class ProjectDeletedError extends ProjectError {
  constructor(projectId: string) {
    super('PROJECT_DELETED', `Project "${projectId}" is deleted and cannot be modified.`, {
      details: { projectId },
    });
    this.name = 'ProjectDeletedError';
  }
}

/** The project is archived; mutating operations are rejected until restored. */
export class ProjectArchivedError extends ProjectError {
  constructor(projectId: string) {
    super('PROJECT_ARCHIVED', `Project "${projectId}" is archived and cannot be modified.`, {
      details: { projectId },
    });
    this.name = 'ProjectArchivedError';
  }
}

export class WorkspaceNotFoundError extends ProjectError {
  constructor(workspaceId: string) {
    super('WORKSPACE_NOT_FOUND', `No workspace found with id "${workspaceId}".`, {
      details: { workspaceId },
    });
    this.name = 'WorkspaceNotFoundError';
  }
}

/** The workspace is not `active`; mutating file operations are rejected. */
export class WorkspaceNotActiveError extends ProjectError {
  constructor(workspaceId: string, status: string) {
    super(
      'WORKSPACE_NOT_ACTIVE',
      `Workspace "${workspaceId}" is ${status}; mutations are rejected.`,
      {
        details: { workspaceId, status },
      },
    );
    this.name = 'WorkspaceNotActiveError';
  }
}

export class FileNodeNotFoundError extends ProjectError {
  constructor(path: string) {
    // Paths are validated before this error can occur, so echoing the path is safe.
    super('FILE_NOT_FOUND', `No file tree node found at path "${path}".`, { details: { path } });
    this.name = 'FileNodeNotFoundError';
  }
}

/** Path validation failed: traversal, absolute path, null bytes, bad encoding. */
export class InvalidPathError extends ProjectError {
  constructor(path: string, reason: string) {
    // The message names the REASON, never the raw input - raw rejected paths can
    // carry payloads; details carry the reason only.
    super('PATH_INVALID', `Invalid workspace path: ${reason}.`, { details: { reason } });
    this.name = 'InvalidPathError';
    void path;
  }
}

/** A node already exists at the target path (duplicate-path prevention). */
export class PathConflictError extends ProjectError {
  constructor(path: string, type: string) {
    super('PATH_CONFLICT', `A ${type} already exists at path "${path}".`, {
      details: { path, type },
    });
    this.name = 'PathConflictError';
  }
}

/** The parent directory for a path does not exist. */
export class MissingParentError extends ProjectError {
  constructor(path: string) {
    super('PATH_PARENT_MISSING', `The parent directory of "${path}" does not exist.`, {
      details: { path },
    });
    this.name = 'MissingParentError';
  }
}

/** A node operation violates file/directory type rules (e.g. non-empty directory delete). */
export class NodeOperationError extends ProjectError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('NODE_INVALID', `Invalid node operation: ${reason}.`, details);
    this.name = 'NodeOperationError';
  }
}

/** Optimistic-concurrency rejection: the caller's revision is outdated. */
export class RevisionConflictError extends ProjectError {
  constructor(entity: string, expectedRevision: number, currentRevision: number) {
    super(
      'REVISION_CONFLICT',
      `Revision conflict on ${entity}: expected revision ${expectedRevision}, current revision is ${currentRevision}.`,
      { details: { entity, expectedRevision, currentRevision } },
    );
    this.name = 'RevisionConflictError';
  }
}

/** A secret-like field or value was rejected. Secrets belong to the future secret system. */
export class SecretRejectedError extends ProjectError {
  constructor(surface: string, reasons: readonly string[]) {
    // Reasons name FIELDS and RULES, never values - a rejected secret never echoes back.
    super('SECRET_REJECTED', `Rejected secret-like content in ${surface}: ${reasons.join('; ')}.`, {
      details: { surface, reasons: [...reasons] },
    });
    this.name = 'SecretRejectedError';
  }
}

export class ContextValidationError extends ProjectError {
  constructor(reasons: readonly string[]) {
    super('CONTEXT_INVALID', `Invalid project context: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'ContextValidationError';
  }
}

export class ConfigValidationError extends ProjectError {
  constructor(reasons: readonly string[]) {
    super('CONFIG_INVALID', `Invalid project configuration: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'ConfigValidationError';
  }
}

export class IntegrationValidationError extends ProjectError {
  constructor(reasons: readonly string[]) {
    super('INTEGRATION_INVALID', `Invalid integration reference: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'IntegrationValidationError';
  }
}

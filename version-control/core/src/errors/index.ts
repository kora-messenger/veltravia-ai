/**
 * Version Control typed errors (Step 18).
 *
 * Every failure carries a stable machine code. Error MESSAGES never contain
 * file contents, secret values, or snapshot material - only bounded metadata.
 */

export const VERSION_ERROR_CODES = [
  'VERSION_REVISION_NOT_FOUND',
  'VERSION_REVISION_FOREIGN_PROJECT',
  'VERSION_REVISION_FOREIGN_WORKSPACE',
  'VERSION_INVALID_TRANSITION',
  'VERSION_STALE_REVISION',
  'VERSION_REVISION_CONFLICT',
  'VERSION_INVALID_ROLLBACK_TARGET',
  'VERSION_CORRUPTED_SNAPSHOT',
  'VERSION_RETENTION_VIOLATION',
  'VERSION_CHECKPOINT_NOT_FOUND',
  'VERSION_OPERATION_NOT_FOUND',
  'VERSION_OPERATION_ALREADY_RESOLVED',
  'VERSION_SECRET_REJECTED',
  'VERSION_SNAPSHOT_NOT_FOUND',
  'VERSION_WORKSPACE_NOT_FOUND',
  'VERSION_PROJECT_NOT_FOUND',
  'VERSION_VALIDATION_FAILED',
  'VERSION_INVALID_REQUEST',
] as const;

export type VersionErrorCode = (typeof VERSION_ERROR_CODES)[number];

export class VersionError extends Error {
  readonly code: VersionErrorCode;
  /** Bounded, scrubbed metadata (never file contents or secrets). */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: VersionErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'VersionError';
    this.code = code;
    this.details = details;
  }
}

export class RevisionNotFoundError extends VersionError {
  constructor(revisionId: string) {
    super('VERSION_REVISION_NOT_FOUND', `Revision "${revisionId}" was not found.`, {
      revisionId,
    });
  }
}

export class ForeignProjectRevisionError extends VersionError {
  constructor() {
    super('VERSION_REVISION_FOREIGN_PROJECT', 'The revision belongs to a different project.');
  }
}

export class ForeignWorkspaceRevisionError extends VersionError {
  constructor() {
    super(
      'VERSION_REVISION_FOREIGN_WORKSPACE',
      'The revision belongs to a different workspace of this project.',
    );
  }
}

export class CorruptedSnapshotError extends VersionError {
  constructor(revisionId: string) {
    super(
      'VERSION_CORRUPTED_SNAPSHOT',
      `The snapshot for revision "${revisionId}" failed its integrity check. Restoring corrupted data is refused.`,
      { revisionId },
    );
  }
}

export class RevisionConflictError extends VersionError {
  constructor(expected: number, actual: number) {
    super(
      'VERSION_REVISION_CONFLICT',
      `The workspace changed while the rollback was being prepared (expected revision ${expected}, current revision ${actual}). Refresh and retry explicitly.`,
      { expectedCurrentRevision: expected, actualCurrentRevision: actual },
    );
  }
}

export class InvalidRollbackTargetError extends VersionError {
  constructor(reason: string) {
    super('VERSION_INVALID_ROLLBACK_TARGET', `Invalid rollback target: ${reason}`);
  }
}

export class RetentionViolationError extends VersionError {
  constructor(message: string) {
    super('VERSION_RETENTION_VIOLATION', message);
  }
}

export class OperationAlreadyResolvedError extends VersionError {
  constructor(operationId: string) {
    super(
      'VERSION_OPERATION_ALREADY_RESOLVED',
      `Rollback operation "${operationId}" is already resolved and cannot be decided or executed again.`,
      { operationId },
    );
  }
}

export class SecretRejectedVersionError extends VersionError {
  /** `paths` are file PATHS only - never contents. */
  constructor(paths: readonly string[]) {
    super(
      'VERSION_SECRET_REJECTED',
      'The workspace tree contains secret-shaped file content; refusing to snapshot it.',
      { paths: paths.length, firstPath: paths[0] ?? null },
    );
  }
}

export class RestoreVerificationError extends VersionError {
  constructor(revisionId: string) {
    super(
      'VERSION_VALIDATION_FAILED',
      `The restored tree does not match the target revision "${revisionId}". The rollback failed closed; no success was reported.`,
      { revisionId },
    );
  }
}

/** True if the value is a typed Version Control error. */
export function isVersionError(value: unknown): value is VersionError {
  return value instanceof VersionError;
}

export type FileIntelligenceErrorCode =
  | 'FILE_INVALID_REQUEST'
  | 'FILE_NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_REJECTED'
  | 'FILE_INVALID_TRANSITION'
  | 'FILE_PATH_UNSAFE'
  | 'FILE_ARCHIVE_REJECTED'
  | 'FILE_EXTRACTION_FAILED'
  | 'FILE_UNAUTHORIZED'
  | 'FILE_EXPIRED'
  | 'FILE_DELETED'
  | 'ARTIFACT_EXPIRED'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_INTEGRITY_FAILURE'
  | 'FILE_INTEGRITY_FAILURE'
  | 'FILE_LIMIT_EXCEEDED';
export class FileIntelligenceError extends Error {
  constructor(
    readonly code: FileIntelligenceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'FileIntelligenceError';
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
export const isFileIntelligenceError = (e: unknown): e is FileIntelligenceError =>
  e instanceof FileIntelligenceError;
export class UnsafePathError extends FileIntelligenceError {
  constructor(reason: string) {
    super('FILE_PATH_UNSAFE', 'The supplied filename or archive path is unsafe.', { reason });
  }
}
export class FileAuthorizationError extends FileIntelligenceError {
  constructor() {
    super('FILE_UNAUTHORIZED', 'The requested file or artifact is outside the authorized scope.');
  }
}

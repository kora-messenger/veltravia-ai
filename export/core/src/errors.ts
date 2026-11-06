import type { ExcludedFile, ExportFailureCode } from './types.js';

export class ExportError extends Error {
  readonly code: ExportFailureCode;
  /** Files left out before the failure, so a failed export can still say why. */
  readonly excluded: readonly ExcludedFile[];
  constructor(code: ExportFailureCode, message: string, excluded: readonly ExcludedFile[] = []) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.excluded = excluded;
  }
}

export function isExportError(error: unknown): error is ExportError {
  return error instanceof ExportError;
}

/** HTTP status for each code. Missing and foreign exports share one answer. */
export function exportHttpStatus(code: ExportFailureCode): number {
  switch (code) {
    case 'EXPORT_INVALID_REQUEST':
    case 'EXPORT_PATH_INVALID':
    case 'EXPORT_SELECTION_EMPTY':
      return 400;
    case 'EXPORT_NOT_FOUND':
      return 404;
    case 'EXPORT_NOT_READY':
    case 'EXPORT_REVISION_CONFLICT':
    case 'EXPORT_NOTHING_TO_EXPORT':
      return 409;
    case 'EXPORT_EXPIRED':
      return 410;
    case 'EXPORT_TOO_LARGE':
      return 413;
    case 'EXPORT_RATE_LIMITED':
      return 429;
    case 'EXPORT_INTERNAL':
      return 500;
  }
}

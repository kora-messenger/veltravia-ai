/** Typed document-intelligence errors with scrubbed, code-first messages. */
export const DOCUMENT_ERROR_CODES = [
  'DOCUMENT_INVALID_REQUEST',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_FORBIDDEN',
  'DOCUMENT_UNSUPPORTED_FORMAT',
  'DOCUMENT_NOT_PROCESSED',
  'DOCUMENT_JOB_NOT_FOUND',
  'DOCUMENT_LIMIT_EXCEEDED',
  'DOCUMENT_PROVIDER_ERROR',
  'DOCUMENT_FILE_ERROR',
  'DOCUMENT_SECRET_REJECTED',
] as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

export class DocumentIntelligenceError extends Error {
  readonly code: DocumentErrorCode;
  readonly httpStatus: number;

  constructor(code: DocumentErrorCode, message?: string) {
    super(message ?? defaultMessage(code));
    this.name = 'DocumentIntelligenceError';
    this.code = code;
    this.httpStatus = httpStatusFor(code);
  }
}

export function isDocumentIntelligenceError(value: unknown): value is DocumentIntelligenceError {
  return value instanceof DocumentIntelligenceError;
}

function httpStatusFor(code: DocumentErrorCode): number {
  switch (code) {
    case 'DOCUMENT_INVALID_REQUEST':
      return 400;
    case 'DOCUMENT_NOT_FOUND':
    case 'DOCUMENT_JOB_NOT_FOUND':
      return 404;
    case 'DOCUMENT_FORBIDDEN':
      return 403;
    case 'DOCUMENT_UNSUPPORTED_FORMAT':
    case 'DOCUMENT_NOT_PROCESSED':
      return 409;
    case 'DOCUMENT_LIMIT_EXCEEDED':
      return 413;
    case 'DOCUMENT_SECRET_REJECTED':
      return 400;
    case 'DOCUMENT_FILE_ERROR':
    case 'DOCUMENT_PROVIDER_ERROR':
      return 502;
    default:
      return 500;
  }
}

function defaultMessage(code: DocumentErrorCode): string {
  switch (code) {
    case 'DOCUMENT_INVALID_REQUEST':
      return 'The document request is invalid.';
    case 'DOCUMENT_NOT_FOUND':
      return 'The document was not found.';
    case 'DOCUMENT_FORBIDDEN':
      return 'The document is outside the authorized scope.';
    case 'DOCUMENT_UNSUPPORTED_FORMAT':
      return 'The document format is not supported.';
    case 'DOCUMENT_NOT_PROCESSED':
      return 'Process the document before reasoning about it.';
    case 'DOCUMENT_JOB_NOT_FOUND':
      return 'The document job was not found.';
    case 'DOCUMENT_LIMIT_EXCEEDED':
      return 'The document exceeds a configured limit.';
    case 'DOCUMENT_PROVIDER_ERROR':
      return 'The document provider failed.';
    case 'DOCUMENT_FILE_ERROR':
      return 'The document could not be read.';
    case 'DOCUMENT_SECRET_REJECTED':
      return 'The document contains secret-shaped content and was rejected.';
    default:
      return 'A document intelligence error occurred.';
  }
}

/** Map a File Intelligence boundary failure into the document vocabulary. */
export function mapFileError(error: unknown): DocumentIntelligenceError {
  const anyError = error as { code?: string; message?: string };
  const code = typeof anyError?.code === 'string' ? anyError.code : '';
  switch (code) {
    case 'FILE_NOT_FOUND':
      return new DocumentIntelligenceError('DOCUMENT_NOT_FOUND');
    case 'FILE_UNAUTHORIZED':
    case 'FILE_EXPIRED':
    case 'FILE_INTEGRITY_FAILURE':
      return new DocumentIntelligenceError('DOCUMENT_FORBIDDEN');
    case 'FILE_TOO_LARGE':
    case 'FILE_LIMIT_EXCEEDED':
      return new DocumentIntelligenceError('DOCUMENT_LIMIT_EXCEEDED');
    case 'FILE_TYPE_REJECTED':
      return new DocumentIntelligenceError('DOCUMENT_UNSUPPORTED_FORMAT');
    default:
      return new DocumentIntelligenceError(
        'DOCUMENT_FILE_ERROR',
        'The document could not be read through the file boundary.',
      );
  }
}

/** Typed, scrubbed errors for Image Intelligence. */
const MESSAGES: Record<string, string> = {
  IMAGE_INVALID_REQUEST: 'The image request was invalid.',
  IMAGE_FILE_NOT_FOUND: 'Image file was not found.',
  IMAGE_UNAUTHORIZED: 'Image access was denied.',
  IMAGE_UNSUPPORTED_FORMAT: 'The image format is not supported.',
  IMAGE_CAPABILITY_UNSUPPORTED: 'The configured image provider does not support this capability.',
  IMAGE_LIMIT_EXCEEDED: 'The image request exceeded a configured limit.',
  IMAGE_JOB_NOT_FOUND: 'Image job was not found.',
  IMAGE_JOB_TERMINAL: 'The image job already finished and cannot change.',
  IMAGE_PROVIDER_ERROR: 'The image provider failed to process the request.',
  IMAGE_PROVIDER_TIMEOUT: 'The image provider timed out.',
  IMAGE_PROCESSING_CANCELLED: 'Image processing was cancelled.',
  IMAGE_NOT_PROCESSED: 'The image has no stored analysis yet. Process it first.',
  IMAGE_INVALID_TRANSITION: 'The image job transition was invalid.',
  IMAGE_EXPIRED: 'The image job or file has expired.',
  IMAGE_ARTIFACT_INVALID: 'The image artifact request was invalid.',
  IMAGE_UNSAFE_IMAGE: 'The image was rejected by a security check.',
};
export type ImageErrorCode = keyof typeof MESSAGES;
export const IMAGE_ERROR_CODES: readonly ImageErrorCode[] = Object.keys(
  MESSAGES,
) as readonly ImageErrorCode[];
export function isImageErrorCode(code: string): code is ImageErrorCode {
  return code in MESSAGES;
}
/** Safe extra details (bounded, scrubbed before leaving this constructor). */
export interface ImageErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}
export class ImageIntelligenceError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    message?: string,
    readonly details: ImageErrorDetails = {},
  ) {
    super(message ?? MESSAGES[code] ?? 'Image intelligence failure.');
    this.name = 'ImageIntelligenceError';
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}
export function isImageIntelligenceError(e: unknown): e is ImageIntelligenceError {
  return e instanceof ImageIntelligenceError;
}
/** HTTP status per code (mirrors the Step 19/20 error mapping). */
export const IMAGE_ERROR_STATUS: Record<ImageErrorCode, number> = {
  IMAGE_INVALID_REQUEST: 400,
  IMAGE_FILE_NOT_FOUND: 404,
  IMAGE_UNAUTHORIZED: 403,
  IMAGE_UNSUPPORTED_FORMAT: 415,
  IMAGE_CAPABILITY_UNSUPPORTED: 422,
  IMAGE_LIMIT_EXCEEDED: 413,
  IMAGE_JOB_NOT_FOUND: 404,
  IMAGE_JOB_TERMINAL: 409,
  IMAGE_PROVIDER_ERROR: 502,
  IMAGE_PROVIDER_TIMEOUT: 504,
  IMAGE_PROCESSING_CANCELLED: 409,
  IMAGE_NOT_PROCESSED: 409,
  IMAGE_INVALID_TRANSITION: 409,
  IMAGE_EXPIRED: 410,
  IMAGE_ARTIFACT_INVALID: 400,
  IMAGE_UNSAFE_IMAGE: 422,
};

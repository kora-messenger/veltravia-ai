/** Typed, scrubbed errors for Video Intelligence. */
const MESSAGES = {
  VIDEO_INVALID_REQUEST: 'The video request was invalid.',
  VIDEO_FILE_NOT_FOUND: 'Video file was not found.',
  VIDEO_UNAUTHORIZED: 'Video access was denied.',
  VIDEO_UNSUPPORTED_FORMAT: 'The video format is not supported.',
  VIDEO_CAPABILITY_UNSUPPORTED: 'The configured video provider does not support this capability.',
  VIDEO_LIMIT_EXCEEDED: 'The video request exceeded a configured limit.',
  VIDEO_JOB_NOT_FOUND: 'Video job was not found.',
  VIDEO_JOB_TERMINAL: 'The video job already finished and cannot change.',
  VIDEO_PROVIDER_ERROR: 'The video provider failed to process the request.',
  VIDEO_PROVIDER_TIMEOUT: 'The video provider timed out.',
  VIDEO_PROCESSING_CANCELLED: 'Video processing was cancelled.',
  VIDEO_NOT_PROCESSED: 'The video has no stored analysis yet. Process it first.',
  VIDEO_INVALID_TRANSITION: 'The video job transition was invalid.',
  VIDEO_EXPIRED: 'The video job or file has expired.',
  VIDEO_ARTIFACT_INVALID: 'The video artifact request was invalid.',
  VIDEO_UNSAFE_VIDEO: 'The video was rejected by a security check.',
};
export type VideoErrorCode = keyof typeof MESSAGES;
export const VIDEO_ERROR_CODES: readonly VideoErrorCode[] = Object.keys(
  MESSAGES,
) as readonly VideoErrorCode[];
export function isVideoErrorCode(code: string): code is VideoErrorCode {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code);
}
/** Safe extra details (bounded, scrubbed before leaving this constructor). */
export interface VideoErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}
export class VideoIntelligenceError extends Error {
  constructor(
    readonly code: VideoErrorCode,
    message?: string,
    readonly details: VideoErrorDetails = {},
  ) {
    super(message ?? MESSAGES[code] ?? 'Video intelligence failure.');
    this.name = 'VideoIntelligenceError';
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}
export function isVideoIntelligenceError(e: unknown): e is VideoIntelligenceError {
  return e instanceof VideoIntelligenceError;
}
/** HTTP status per code (mirrors the Step 19-21 error mapping). */
export const VIDEO_ERROR_STATUS: Record<VideoErrorCode, number> = {
  VIDEO_INVALID_REQUEST: 400,
  VIDEO_FILE_NOT_FOUND: 404,
  VIDEO_UNAUTHORIZED: 403,
  VIDEO_UNSUPPORTED_FORMAT: 415,
  VIDEO_CAPABILITY_UNSUPPORTED: 422,
  VIDEO_LIMIT_EXCEEDED: 413,
  VIDEO_JOB_NOT_FOUND: 404,
  VIDEO_JOB_TERMINAL: 409,
  VIDEO_PROVIDER_ERROR: 502,
  VIDEO_PROVIDER_TIMEOUT: 504,
  VIDEO_PROCESSING_CANCELLED: 409,
  VIDEO_NOT_PROCESSED: 409,
  VIDEO_INVALID_TRANSITION: 409,
  VIDEO_EXPIRED: 410,
  VIDEO_ARTIFACT_INVALID: 400,
  VIDEO_UNSAFE_VIDEO: 422,
};

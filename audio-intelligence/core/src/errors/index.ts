/** Typed, scrubbed errors for Audio Intelligence. */
const MESSAGES: Record<string, string> = {
  AUDIO_INVALID_REQUEST: 'The audio request was invalid.',
  AUDIO_FILE_NOT_FOUND: 'Audio file was not found.',
  AUDIO_UNAUTHORIZED: 'Audio access was denied.',
  AUDIO_UNSUPPORTED_FORMAT: 'The audio format is not supported.',
  AUDIO_CAPABILITY_UNSUPPORTED: 'The configured audio provider does not support this capability.',
  AUDIO_LIMIT_EXCEEDED: 'The audio request exceeded a configured limit.',
  AUDIO_JOB_NOT_FOUND: 'Audio job was not found.',
  AUDIO_JOB_TERMINAL: 'The audio job already finished and cannot change.',
  AUDIO_PROVIDER_ERROR: 'The audio provider failed to process the request.',
  AUDIO_PROVIDER_TIMEOUT: 'The audio provider timed out.',
  AUDIO_PROCESSING_CANCELLED: 'Audio processing was cancelled.',
  AUDIO_NOT_PROCESSED: 'The audio file has no transcript yet. Process it first.',
  AUDIO_INVALID_TRANSITION: 'The audio job transition was invalid.',
  AUDIO_EXPIRED: 'The audio job or file has expired.',
  AUDIO_ARTIFACT_INVALID: 'The audio artifact draft was invalid.',
};
export type AudioErrorCode = keyof typeof MESSAGES;
export const AUDIO_ERROR_CODES: readonly AudioErrorCode[] = Object.keys(
  MESSAGES,
) as readonly AudioErrorCode[];
export function isAudioErrorCode(code: string): code is AudioErrorCode {
  return code in MESSAGES;
}
/** Safe extra details (bounded, scrubbed before leaving this constructor). */
export interface AudioErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}
export class AudioIntelligenceError extends Error {
  constructor(
    readonly code: AudioErrorCode,
    message?: string,
    readonly details: AudioErrorDetails = {},
  ) {
    super(message ?? MESSAGES[code] ?? 'Audio intelligence failure.');
    this.name = 'AudioIntelligenceError';
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}
export function isAudioIntelligenceError(e: unknown): e is AudioIntelligenceError {
  return e instanceof AudioIntelligenceError;
}
/** HTTP status per code (mirrors the Step 19 file error mapping). */
export const AUDIO_ERROR_STATUS: Record<AudioErrorCode, number> = {
  AUDIO_INVALID_REQUEST: 400,
  AUDIO_FILE_NOT_FOUND: 404,
  AUDIO_UNAUTHORIZED: 403,
  AUDIO_UNSUPPORTED_FORMAT: 415,
  AUDIO_CAPABILITY_UNSUPPORTED: 422,
  AUDIO_LIMIT_EXCEEDED: 413,
  AUDIO_JOB_NOT_FOUND: 404,
  AUDIO_JOB_TERMINAL: 409,
  AUDIO_PROVIDER_ERROR: 502,
  AUDIO_PROVIDER_TIMEOUT: 504,
  AUDIO_PROCESSING_CANCELLED: 409,
  AUDIO_NOT_PROCESSED: 409,
  AUDIO_INVALID_TRANSITION: 409,
  AUDIO_EXPIRED: 410,
  AUDIO_ARTIFACT_INVALID: 400,
};

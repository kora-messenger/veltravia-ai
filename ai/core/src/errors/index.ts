/**
 * Veltravia AI's normalized error system.
 *
 * Provider adapters MUST convert vendor-specific failures into these typed
 * errors before they leave the adapter boundary - application code never
 * sees vendor error shapes.
 */
export type AIErrorCode =
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_NOT_FOUND'
  | 'AI_MODEL_NOT_FOUND'
  | 'AI_CAPABILITY_NOT_SUPPORTED'
  | 'AI_PROVIDER_ERROR'
  | 'AI_CONFIGURATION_ERROR';

export interface AIErrorOptions {
  /** Structured context (model id, capability, provider id, ...). Never secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base class for every AI Core error. Carries a stable machine-readable `code`. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: AIErrorCode, message: string, options?: AIErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.details = options?.details;
  }

  /** JSON-safe representation for logs and API responses. Excludes the stack. */
  toJSON(): { code: AIErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** The request is structurally invalid or violates configured limits. */
export class InvalidAIRequestError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_INVALID_REQUEST', message, options);
  }
}

/** The provider referenced by a model is not registered (or not enabled). */
export class ProviderNotFoundError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_PROVIDER_NOT_FOUND', message, options);
  }
}

/** The referenced model is not in the registry (or is unavailable). */
export class ModelNotFoundError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_MODEL_NOT_FOUND', message, options);
  }
}

/** No registered, available model supports the requested capabilities. */
export class CapabilityNotSupportedError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_CAPABILITY_NOT_SUPPORTED', message, options);
  }
}

/** A provider call failed. Vendor-specific errors are wrapped in this. */
export class AIProviderError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_PROVIDER_ERROR', message, options);
  }
}

/** The AI configuration (or registry wiring) is invalid. */
export class AIConfigurationError extends AIError {
  constructor(message: string, options?: AIErrorOptions) {
    super('AI_CONFIGURATION_ERROR', message, options);
  }
}

/** Type guard for AIError (cross-package instanceof safety). */
export function isAIError(value: unknown): value is AIError {
  return value instanceof AIError;
}

import { redactSecrets, scrubDetails } from '@veltravia/connector-core';

/**
 * Typed tool error system - mirrors the AI Core and connector error designs
 * so the whole platform shares one error philosophy: stable machine codes,
 * normalized shapes, and no vendor/implementation details leaking out.
 *
 * SECURITY: the base constructor scrubs token/secret-looking substrings out
 * of the message and of any `details` strings - a credential that
 * accidentally reaches an error can never surface through `message`,
 * `details`, or `toJSON()`. Tests assert this against known token shapes.
 */

export const TOOL_ERROR_CODES = [
  'TOOL_NOT_FOUND',
  'DUPLICATE_TOOL',
  'INVALID_TOOL_DEFINITION',
  'INVALID_TOOL_INPUT',
  'TOOL_PERMISSION',
  'TOOL_CONFIRMATION_REQUIRED',
  'TOOL_CONFIRMATION_REJECTED',
  'TOOL_UNAVAILABLE',
  'TOOL_EXECUTION',
  'TOOL_OUTPUT_VALIDATION',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for every tool-framework failure. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(redactSecrets(message), { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.details !== undefined) {
      this.details = scrubDetails(options.details) as Readonly<Record<string, unknown>>;
    }
  }

  /** Serializable, stack-free, secret-free representation for API surfaces. */
  toJSON(): { code: ToolErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/** A tool id was used that is not registered. */
export class ToolNotFoundError extends ToolError {
  constructor(toolId: string) {
    super('TOOL_NOT_FOUND', `No tool registered with id "${toolId}".`, {
      details: { toolId },
    });
  }
}

/** A tool was registered with an id that already exists. */
export class DuplicateToolError extends ToolError {
  constructor(toolId: string) {
    super('DUPLICATE_TOOL', `A tool with id "${toolId}" is already registered.`, {
      details: { toolId },
    });
  }
}

/** A tool definition failed structural validation (all reasons reported). */
export class InvalidToolDefinitionError extends ToolError {
  constructor(reasons: readonly string[]) {
    super('INVALID_TOOL_DEFINITION', `Invalid tool definition: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
  }
}

/**
 * Tool input failed schema validation. Messages name FIELDS, never values -
 * input values are untrusted and could contain secrets.
 */
export class InvalidToolInputError extends ToolError {
  constructor(toolId: string, problems: readonly string[]) {
    super('INVALID_TOOL_INPUT', `Input for tool "${toolId}" is invalid: ${problems.join('; ')}.`, {
      details: { toolId, problems: [...problems] },
    });
  }
}

/** A tool permission requirement was not satisfied (not granted). */
export class ToolPermissionError extends ToolError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('TOOL_PERMISSION', message, { details });
  }
}

/** An invocation needs human confirmation before it may proceed. */
export class ToolConfirmationRequiredError extends ToolError {
  constructor(toolId: string, confirmationId: string) {
    super(
      'TOOL_CONFIRMATION_REQUIRED',
      `Tool "${toolId}" requires confirmation before execution.`,
      {
        details: { toolId, confirmationId },
      },
    );
  }
}

/** A human explicitly rejected the confirmation for an invocation. */
export class ToolConfirmationRejectedError extends ToolError {
  constructor(toolId: string, confirmationId: string) {
    super('TOOL_CONFIRMATION_REJECTED', `Confirmation for tool "${toolId}" was rejected.`, {
      details: { toolId, confirmationId },
    });
  }
}

/** The tool exists but is not currently executable (disabled, missing connector, ...). */
export class ToolUnavailableError extends ToolError {
  constructor(toolId: string, reason: string) {
    super('TOOL_UNAVAILABLE', `Tool "${toolId}" is unavailable: ${reason}`, {
      details: { toolId },
    });
  }
}

/** Execution itself failed (handler threw, or execution is not enabled). */
export class ToolExecutionError extends ToolError {
  constructor(toolId: string, reason: string, options: ToolErrorOptions = {}) {
    super('TOOL_EXECUTION', `Execution of tool "${toolId}" failed: ${reason}`, {
      ...options,
      details: { toolId, ...(options.details ?? {}) },
    });
  }
}

/** A tool produced output that violates its declared output schema. */
export class ToolOutputValidationError extends ToolError {
  constructor(toolId: string, problems: readonly string[]) {
    super(
      'TOOL_OUTPUT_VALIDATION',
      `Output of tool "${toolId}" violates its schema: ${problems.join('; ')}.`,
      { details: { toolId, problems: [...problems] } },
    );
  }
}

/** Type guard for ToolError (works across compiled/js source copies). */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

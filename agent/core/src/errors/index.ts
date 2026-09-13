/** Options for agent errors: safe details + error cause. */
export interface AgentErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Agent error codes - stable, typed, and regex-able in tests.
 */
export const AGENT_ERROR_CODES = [
  'AGENT_INVALID_REQUEST',
  'AGENT_NOT_FOUND',
  'AGENT_DUPLICATE',
  'AGENT_INVALID_DECISION',
  'AGENT_MODEL_ERROR',
  'AGENT_INVALID_TRANSITION',
  'AGENT_RUN_NOT_FOUND',
  'AGENT_RUN_TERMINAL',
  'AGENT_LIMITS_INVALID',
  'AGENT_NOT_ALLOWED',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** Secret-shaped patterns scrubbed from every agent error and audit event. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /eyJhbGciOi[A-Za-z0-9._-]{20,}/g,
  /(?:api[_-]?key|secret|password|token|credential)s?\s*[:=]\s*\S+/gi,
];

/** Scrubs secret-shaped substrings from a string (used for ALL agent error surfaces). */
export function scrubAgentSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
}

/** Scrubs secret-shaped values from arbitrary JSON metadata (in place, deep). */
export function scrubAgentMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubAgentSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[scrubAgentSecrets(key)] = walk(inner);
      return out;
    }
    return value;
  };
  return walk(metadata) as Record<string, unknown>;
}

/** Base class for every agent error. Secrets are scrubbed from messages + details. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: AgentErrorCode, message: string, options?: AgentErrorOptions) {
    super(scrubAgentSecrets(message), options);
    this.name = 'AgentError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = scrubAgentMetadata(options.details) as Record<string, unknown>;
    }
  }

  /** Structured, stack-free representation for API/audit surfaces. */
  toJSON(): { code: AgentErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class InvalidAgentRequestError extends AgentError {
  constructor(reasons: readonly string[]) {
    super('AGENT_INVALID_REQUEST', `Invalid agent request: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'InvalidAgentRequestError';
  }
}

export class AgentNotFoundError extends AgentError {
  constructor(agentId: string) {
    super('AGENT_NOT_FOUND', `No agent registered with id "${agentId}".`, {
      details: { agentId },
    });
    this.name = 'AgentNotFoundError';
  }
}

export class DuplicateAgentError extends AgentError {
  constructor(agentId: string) {
    super('AGENT_DUPLICATE', `An agent with id "${agentId}" is already registered.`, {
      details: { agentId },
    });
    this.name = 'DuplicateAgentError';
  }
}

/** The model produced output that is not a valid, actionable decision. */
export class InvalidAgentDecisionError extends AgentError {
  constructor(reasons: readonly string[]) {
    super('AGENT_INVALID_DECISION', `Invalid agent decision: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'InvalidAgentDecisionError';
  }
}

/** The decision source (model bridge) failed or returned unusable output. */
export class AgentModelError extends AgentError {
  constructor(message: string, options?: AgentErrorOptions) {
    super('AGENT_MODEL_ERROR', message, options);
    this.name = 'AgentModelError';
  }
}

export class InvalidAgentTransitionError extends AgentError {
  constructor(from: string, to: string) {
    super('AGENT_INVALID_TRANSITION', `Agent transition ${from} → ${to} is not allowed.`, {
      details: { from, to },
    });
    this.name = 'InvalidAgentTransitionError';
  }
}

export class AgentRunNotFoundError extends AgentError {
  constructor(runId: string) {
    super('AGENT_RUN_NOT_FOUND', `No agent run with id "${runId}".`, {
      details: { runId },
    });
    this.name = 'AgentRunNotFoundError';
  }
}

/** The run already reached a terminal status (completed/failed/cancelled/limit_reached). */
export class AgentRunTerminalError extends AgentError {
  constructor(runId: string, status: string, action: string) {
    super('AGENT_RUN_TERMINAL', `Run "${runId}" is ${status}; cannot ${action}.`, {
      details: { runId, status, action },
    });
    this.name = 'AgentRunTerminalError';
  }
}

export class InvalidAgentLimitsError extends AgentError {
  constructor(reasons: readonly string[]) {
    super('AGENT_LIMITS_INVALID', `Invalid execution limits: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
    this.name = 'InvalidAgentLimitsError';
  }
}

/** An action would bypass the agent's security rules (self-approval, resume of a cancelled run, ...). */
export class AgentNotAllowedError extends AgentError {
  constructor(message: string, options?: AgentErrorOptions) {
    super('AGENT_NOT_ALLOWED', message, options);
    this.name = 'AgentNotAllowedError';
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

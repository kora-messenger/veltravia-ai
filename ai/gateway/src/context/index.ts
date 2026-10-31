import type { AIMessage } from '@veltravia/ai-core';

import { GatewayError } from '../errors/index.js';
import { redact } from '../security/index.js';

/**
 * Context preparation (Step 29).
 *
 * One job: hand the provider a prompt that fits the model's window, with the
 * least data necessary and nothing secret in it. Everything here is
 * conservative - when a fact is unknown (no declared window), the context is
 * left alone rather than guessed at, and the caller is told what happened.
 */

/** Characters-per-token estimate. Deliberately labelled as an estimate. */
const CHARS_PER_TOKEN = 4;
/** Room kept for the answer and protocol overhead beyond maxOutputTokens. */
const SAFETY_TOKENS = 256;

export interface ContextBudget {
  /** Model window in tokens, when the vendor or owner declared one. */
  readonly contextWindowTokens: number | null;
  /** Tokens the answer may use. Subtracted from the window. */
  readonly maxOutputTokens: number;
}

export interface ContextInput {
  readonly system?: string;
  readonly messages: readonly AIMessage[];
  readonly budget: ContextBudget;
}

export interface ContextResult {
  readonly system?: string;
  readonly messages: readonly AIMessage[];
  /** Estimated, never presented as provider-reported usage. */
  readonly estimatedInputTokens: number;
  readonly truncated: boolean;
  readonly droppedMessages: number;
  /** Plain notes for the UI and the audit trail. */
  readonly notes: readonly string[];
  /** True when no window was known, so no fitting was attempted. */
  readonly unbounded: boolean;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: readonly AIMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
}

/**
 * Fits the prompt into the window by dropping the OLDEST messages first.
 *
 * The system prompt and the newest user message are never dropped: if those
 * alone do not fit, the request is refused with a typed error instead of being
 * silently cut down to something that answers a different question.
 */
export function prepareContext(input: ContextInput): ContextResult {
  const notes: string[] = [];
  const system = input.system === undefined ? undefined : redact(input.system);
  const cleaned = input.messages.map((message) => ({
    role: message.role,
    content: redact(message.content),
  }));

  const window = input.budget.contextWindowTokens;
  const systemTokens = system === undefined ? 0 : estimateTokens(system) + 4;
  const outputReserve = Math.max(0, input.budget.maxOutputTokens);
  const estimatedInputTokens = systemTokens + estimateMessagesTokens(cleaned);

  if (window === null || window <= 0) {
    return {
      ...(system !== undefined ? { system } : {}),
      messages: cleaned,
      estimatedInputTokens,
      truncated: false,
      droppedMessages: 0,
      notes: ['The model declares no context window, so the prompt was sent unchanged.'],
      unbounded: true,
    };
  }

  const available = window - outputReserve - SAFETY_TOKENS;
  if (available <= 0) {
    throw new GatewayError(
      'GATEWAY_CONTEXT_TOO_LARGE',
      'The requested answer length leaves no room for the prompt on this model.',
      { details: { contextWindowTokens: window, maxOutputTokens: outputReserve } },
    );
  }

  let kept = [...cleaned];
  let dropped = 0;
  let used = systemTokens + estimateMessagesTokens(kept);
  while (used > available && kept.length > 1) {
    // Never drop the final user message: that is the actual question.
    kept = kept.slice(1);
    dropped += 1;
    used = systemTokens + estimateMessagesTokens(kept);
  }

  if (used > available) {
    throw new GatewayError(
      'GATEWAY_CONTEXT_TOO_LARGE',
      'This prompt is larger than the model can accept, even with history removed.',
      { details: { contextWindowTokens: window, estimatedInputTokens: used } },
    );
  }

  if (dropped > 0) {
    notes.push(
      `${dropped} earlier message${dropped === 1 ? '' : 's'} were left out to fit the model's context window.`,
    );
  }

  return {
    ...(system !== undefined ? { system } : {}),
    messages: kept,
    estimatedInputTokens: used,
    truncated: dropped > 0,
    droppedMessages: dropped,
    notes,
    unbounded: false,
  };
}

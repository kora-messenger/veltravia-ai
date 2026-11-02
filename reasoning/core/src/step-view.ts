import type { ReasoningToolStep } from './engine.js';
import { scrubReasoningText } from './errors.js';

/**
 * The public shape of one step.
 *
 * The engine keeps a step's raw arguments and output as records, because that is
 * what the tools and the context builder work with. The browser must never be
 * handed those records: they can hold file contents, absolute paths, or a
 * credential a tool echoed back. So a step becomes a *view* here, once, with:
 *
 * - one name per status the interface actually renders (`failed`, `rejected`),
 *   instead of the engine's finer distinction between a failure and a refusal;
 * - a duration computed from the two timestamps the engine already records;
 * - `command` and `output` rendered as plain text, secret-scrubbed, and cut to a
 *   fixed size so one enormous file cannot become a megabyte of chat.
 *
 * Everything here is derived. Nothing is invented: a step that produced no
 * output has `output: null`, and the panel says so rather than showing a blank
 * box that looks like an empty result.
 */

export type StepViewStatus = 'success' | 'failed' | 'rejected' | 'pending_confirmation';

export interface ReasoningStepView {
  readonly id: string;
  readonly toolId: string;
  readonly intent: string;
  readonly status: StepViewStatus;
  readonly durationMs: number | null;
  /** The tool and its arguments, as text. Null when the step ran nothing. */
  readonly command: string | null;
  /** What the tool returned, or why it failed. Null when there was nothing. */
  readonly output: string | null;
  /** True when `command` or `output` was cut, so the panel can say it is partial. */
  readonly truncated: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A command is a line or two of arguments; past this it stops being readable. */
export const MAX_COMMAND_CHARS = 1200;
/** Output is worth more room, but still bounded. */
export const MAX_OUTPUT_CHARS = 4000;

const STATUS: Record<ReasoningToolStep['status'], StepViewStatus> = {
  success: 'success',
  failure: 'failed',
  denied: 'rejected',
  awaiting_confirmation: 'pending_confirmation',
};

function render(value: unknown, max: number): { text: string; cut: boolean } {
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const scrubbed = scrubReasoningText(raw);
  if (scrubbed.length <= max) return { text: scrubbed, cut: false };
  return { text: `${scrubbed.slice(0, max)}…`, cut: true };
}

/** `toolId` on its own line, its arguments beneath it: what was asked for. */
function renderCommand(step: ReasoningToolStep): { text: string; cut: boolean } | null {
  if (step.input === undefined) return null;
  const keys = Object.keys(step.input);
  const body = keys.length === 0 ? '' : render(step.input, MAX_COMMAND_CHARS);
  if (body === '') return { text: step.toolId, cut: false };
  return { text: `${step.toolId}\n${body.text}`, cut: body.cut };
}

function renderOutput(step: ReasoningToolStep): { text: string; cut: boolean } | null {
  if (step.output !== undefined) return render(step.output, MAX_OUTPUT_CHARS);
  // A failed step has no output but does have a reason. Showing the reason in the
  // output slot is what a person expects: the panel answers "what came back".
  if (step.error !== undefined) {
    return render({ error: step.error.code, message: step.error.message }, MAX_OUTPUT_CHARS);
  }
  return null;
}

function durationMs(step: ReasoningToolStep): number | null {
  const start = Date.parse(step.requestedAt);
  const end = Date.parse(step.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function toStepView(step: ReasoningToolStep): ReasoningStepView {
  const command = renderCommand(step);
  const output = renderOutput(step);
  return {
    id: step.stepId,
    toolId: step.toolId,
    intent: step.intent,
    status: STATUS[step.status],
    durationMs: durationMs(step),
    command: command === null ? null : command.text,
    output: output === null ? null : output.text,
    truncated: command?.cut === true || output?.cut === true,
    ...(step.error !== undefined ? { error: step.error } : {}),
  };
}

/**
 * A whole run, with its steps replaced by their public views. Every other field
 * is passed through untouched: this is a narrowing of one field, not a rewrite of
 * the run.
 */
export function toRunView<T extends { readonly steps: readonly ReasoningToolStep[] }>(
  run: T,
): Omit<T, 'steps'> & { readonly steps: readonly ReasoningStepView[] } {
  return { ...run, steps: run.steps.map(toStepView) };
}

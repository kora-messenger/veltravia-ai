/**
 * The validated shapes a model is allowed to produce. Nothing here is ever
 * taken from raw model text: each parser checks every field, caps every
 * string, and rejects unknown members, so a model cannot smuggle a new
 * instruction, a new tool id or an unauthorized argument into the pipeline.
 *
 * These are TASK STRUCTURES, not chain-of-thought. The engine stores concise
 * decisions and evidence, never hidden reasoning traces.
 */

import { ReasoningError } from './errors.js';

/** The task kinds the classifier may return. Closed set. */
export const REASONING_TASK_TYPES = [
  'question',
  'analysis',
  'planning',
  'coding',
  'document',
  'research',
  'action',
] as const;

export type ReasoningTaskType = (typeof REASONING_TASK_TYPES)[number];

export function isReasoningTaskType(value: unknown): value is ReasoningTaskType {
  return typeof value === 'string' && (REASONING_TASK_TYPES as readonly string[]).includes(value);
}

export interface TaskClassification {
  readonly taskType: ReasoningTaskType;
  /** True when the task cannot be answered without reading platform resources. */
  readonly needsTools: boolean;
  /** One concise sentence, safe to show. Never a reasoning trace. */
  readonly rationale: string;
}

export interface PlanStep {
  /** Stable, engine-assigned id (`s1`, `s2`, ...). */
  readonly id: string;
  /** What this step is for, in one sentence. */
  readonly intent: string;
  /** The tool this step needs, or null for a reasoning-only step. */
  readonly toolId: string | null;
  /** Arguments the model proposed; validated against the tool schema by the Tool System. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ExecutionPlan {
  readonly goal: string;
  readonly steps: readonly PlanStep[];
}

export interface CompletionAssessment {
  readonly complete: boolean;
  /** Concise summary of what was achieved (or what is missing). */
  readonly summary: string;
}

/** The safest maximimum lengths. Over-long model output is truncated, never trusted whole. */
export const LIMITS = {
  rationale: 400,
  intent: 300,
  goal: 500,
  answer: 20_000,
  summary: 600,
  toolId: 120,
  maxPlanSteps: 6,
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

function invalid(
  message: string,
  code: 'REASONING_INVALID_MODEL_OUTPUT' = 'REASONING_INVALID_MODEL_OUTPUT',
) {
  return new ReasoningError(code, message);
}

/**
 * Extracts the single JSON object a reasoning step must reply with. Anything
 * else (prose, multiple objects, a bare array, malformed JSON) is rejected -
 * the engine never guesses what the model meant.
 */
export function extractModelJson(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw invalid('The model returned an empty response.');
  }
  const unfenced = content.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1) {
    throw invalid('The model response contained no structured object.');
  }
  if (end <= start) {
    throw invalid('The model response was not valid JSON.');
  }
  const candidate = unfenced.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw invalid('The model response was not valid JSON.');
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    throw invalid('The model response was not a JSON object.');
  }
  return record;
}

/** Validates a task classification. */
export function parseTaskClassification(raw: unknown): TaskClassification {
  const record = asRecord(raw);
  if (record === undefined) throw invalid('Task classification must be an object.');
  if (!isReasoningTaskType(record.taskType)) {
    throw invalid('Task classification returned an unknown task type.');
  }
  if (typeof record.needsTools !== 'boolean') {
    throw invalid('Task classification must state whether tools are needed.');
  }
  const rationale = readString(record, 'rationale', LIMITS.rationale) ?? 'Task classified.';
  return { taskType: record.taskType, needsTools: record.needsTools, rationale };
}

export interface ParsePlanOptions {
  /** Tool ids the server will actually allow; anything else is rejected outright. */
  readonly allowedTools: readonly string[];
  readonly maxSteps?: number;
}

/**
 * Validates an execution plan. A plan step naming a tool outside the allowed
 * set is REJECTED (not silently dropped): a model that invents a tool must be
 * corrected, never half-obeyed.
 */
export function parseExecutionPlan(raw: unknown, options: ParsePlanOptions): ExecutionPlan {
  const record = asRecord(raw);
  if (record === undefined) throw invalid('Execution plan must be an object.');
  const goal = readString(record, 'goal', LIMITS.goal) ?? 'Complete the request.';
  const stepsRaw = record.steps;
  if (stepsRaw === undefined) {
    return { goal, steps: [] };
  }
  if (!Array.isArray(stepsRaw)) throw invalid('Execution plan steps must be an array.');
  const maxSteps = Math.min(options.maxSteps ?? LIMITS.maxPlanSteps, LIMITS.maxPlanSteps);
  if (stepsRaw.length > maxSteps) {
    throw invalid(`Execution plan exceeds the maximum of ${maxSteps} steps.`);
  }
  const allowed = new Set(options.allowedTools);
  const steps: PlanStep[] = [];
  stepsRaw.forEach((entry, index) => {
    const stepRecord = asRecord(entry);
    if (stepRecord === undefined) throw invalid('Each execution plan step must be an object.');
    const intent = readString(stepRecord, 'intent', LIMITS.intent);
    if (intent === undefined) throw invalid('Each execution plan step needs an intent.');
    let toolId: string | null = null;
    if (stepRecord.toolId !== undefined && stepRecord.toolId !== null) {
      const proposed = readString(stepRecord, 'toolId', LIMITS.toolId);
      if (proposed === undefined) throw invalid('Plan step toolId must be a non-empty string.');
      if (!allowed.has(proposed)) {
        throw new ReasoningError(
          'REASONING_TOOL_NOT_ALLOWED',
          'The model proposed a tool this run may not use.',
          { toolId: proposed.slice(0, LIMITS.toolId) },
        );
      }
      toolId = proposed;
    }
    let input: Record<string, unknown> = {};
    if (stepRecord.input !== undefined) {
      const candidate = asRecord(stepRecord.input);
      if (candidate === undefined) {
        throw new ReasoningError(
          'REASONING_TOOL_INPUT_INVALID',
          'Plan step arguments must be a JSON object.',
        );
      }
      input = candidate;
    }
    steps.push({ id: `s${index + 1}`, intent, toolId, input });
  });
  return { goal, steps };
}

/** The action set a follow-up reasoning turn may propose. */
export type ReasoningAction =
  | {
      readonly type: 'tool';
      readonly toolId: string;
      readonly input: Record<string, unknown>;
      readonly intent: string;
    }
  | { readonly type: 'answer'; readonly answer: string }
  | { readonly type: 'stop'; readonly summary: string };

/**
 * Validates one action from a follow-up turn. Mirrors plan validation: an
 * unknown tool or non-object arguments are errors, not warnings.
 */
export function parseAction(raw: unknown, options: ParsePlanOptions): ReasoningAction {
  const record = asRecord(raw);
  if (record === undefined) throw invalid('A reasoning action must be an object.');
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'answer') {
    const answer = readString(record, 'answer', LIMITS.answer);
    if (answer === undefined) throw invalid('An answer action needs non-empty text.');
    return { type: 'answer', answer };
  }
  if (type === 'stop') {
    return {
      type: 'stop',
      summary: readString(record, 'summary', LIMITS.summary) ?? 'No further action taken.',
    };
  }
  if (type === 'tool') {
    const allowed = new Set(options.allowedTools);
    const toolId = readString(record, 'toolId', LIMITS.toolId);
    if (toolId === undefined) throw invalid('A tool action needs a toolId.');
    if (!allowed.has(toolId)) {
      throw new ReasoningError(
        'REASONING_TOOL_NOT_ALLOWED',
        'The model requested a tool this run may not use.',
        { toolId: toolId.slice(0, LIMITS.toolId) },
      );
    }
    const input = asRecord(record.input) ?? {};
    if (record.input !== undefined && asRecord(record.input) === undefined) {
      throw new ReasoningError(
        'REASONING_TOOL_INPUT_INVALID',
        'Tool arguments must be a JSON object.',
      );
    }
    return {
      type: 'tool',
      toolId,
      input,
      intent: readString(record, 'intent', LIMITS.intent) ?? 'Use a tool to gather information.',
    };
  }
  throw invalid('The model returned an action this platform does not accept.');
}

/** Validates a completion assessment. */
export function parseCompletionAssessment(raw: unknown): CompletionAssessment {
  const record = asRecord(raw);
  if (record === undefined) throw invalid('The completion assessment must be an object.');
  if (typeof record.complete !== 'boolean') {
    throw invalid('The completion assessment must state whether the task is complete.');
  }
  return {
    complete: record.complete,
    summary: readString(record, 'summary', LIMITS.summary) ?? 'Assessment recorded.',
  };
}

/** Validates a plain-text final answer (no JSON required for the last step). */
export function parseFinalAnswer(content: unknown): string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw invalid('The model returned no final answer.');
  }
  return content.trim().slice(0, LIMITS.answer);
}

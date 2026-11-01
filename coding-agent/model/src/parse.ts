/**
 * Parsing model output into a decision.
 *
 * Model output is untrusted text. It is never executed, never written to a
 * file, and never trusted to grant anything. This module only turns it into a
 * JSON object; the coding agent's own validator then decides whether the
 * decision is legal.
 */

import { ModelCodingError, scrubModelText } from './errors.js';

/** Removes code fences and leading prose, then finds the outermost JSON object. */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in the reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  throw new Error('the JSON object in the reply is not closed');
}

export function parseModelDecision(text: string): unknown {
  let json: string;
  try {
    json = extractJsonObject(text);
  } catch (error) {
    throw new ModelCodingError(
      'CODING_MODEL_INVALID_OUTPUT',
      `the model reply was not a JSON object: ${scrubModelText((error as Error).message)}`,
    );
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new ModelCodingError(
      'CODING_MODEL_INVALID_OUTPUT',
      `the model reply was not valid JSON: ${scrubModelText((error as Error).message)}`,
    );
  }
}

/**
 * Plan list fields, in the order the prompt declares them.
 *
 * A live model wrote `validationStrategy` as one sentence instead of a list
 * (Step 35 live QA against Gemini), which the validator rightly refuses. The
 * envelope is well defined, so a lone string is read as a one-item list. Every
 * other type is left untouched for the validator to reject: this widens the
 * accepted shape of a declared list, never the rules about its content.
 */
const PLAN_LIST_FIELDS = [
  'filesToInspect',
  'filesToModify',
  'filesToCreate',
  'filesToDelete',
  'validations',
  'acceptanceCriteria',
  'dependencies',
  'risks',
  'validationStrategy',
  'approvalRequirements',
] as const;

export interface NormalisedDecision {
  readonly value: unknown;
  /** Fields that were accepted as a single string and read as a one-item list. */
  readonly coercedLists: readonly string[];
}

/** Reads declared list fields that arrived as a single string as one-item lists. */
export function normaliseDecisionShape(raw: unknown): NormalisedDecision {
  if (raw === null || typeof raw !== 'object') return { value: raw, coercedLists: [] };
  const outer = raw as Record<string, unknown>;
  if (outer.type !== 'plan') return { value: raw, coercedLists: [] };
  const plan = outer.plan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return { value: raw, coercedLists: [] };
  }
  const fields = plan as Record<string, unknown>;
  const coerced: string[] = [];
  const next: Record<string, unknown> = { ...fields };
  for (const field of PLAN_LIST_FIELDS) {
    const value = fields[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    next[field] = [trimmed];
    coerced.push(field);
  }
  if (coerced.length === 0) return { value: raw, coercedLists: [] };
  return { value: { ...outer, plan: next }, coercedLists: coerced };
}

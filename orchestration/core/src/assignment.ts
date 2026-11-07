/**
 * Worker assignment contracts, and the rule for judging what comes back.
 *
 * An assignment is what a future worker would be handed: what to do, where it
 * may touch, what it must return, and how completion is decided. Validation
 * here is deliberately strict, because a vague assignment is the reason
 * delegation fails quietly.
 *
 * `assessCompletion` is the primary agent's judgement made mechanical: it reads
 * delivered outputs and acceptance results and says completed, partially
 * completed, blocked, failed or incomplete. It never invents evidence, and an
 * unverified criterion is not a satisfied one.
 */

import { OrchestrationError } from './errors.js';
import type { AcceptanceCriterion, TaskAssignment, TaskLimits, TaskPermissions } from './types.js';
import { TASK_LIMITS } from './types.js';

const KNOWN_TOOLS = new Set<string>([
  'read_file',
  'write_file',
  'list_files',
  'search',
  'run_command',
  'run_tests',
  'git_commit',
  'github_read',
  'github_write',
  'reasoning',
  'document_read',
]);

const MAX_TOOL_NAME = 64;

function isStringArray(value: unknown, maxItems = 50): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 512)
  );
}

function isPermissions(value: unknown): value is TaskPermissions {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.canReadProject === 'boolean' &&
    typeof candidate.canWriteProject === 'boolean' &&
    typeof candidate.canRunTools === 'boolean' &&
    typeof candidate.canUseNetwork === 'boolean'
  );
}

function isLimits(value: unknown): value is TaskLimits {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const okNumber = (input: unknown): boolean =>
    input === null || (typeof input === 'number' && Number.isFinite(input) && input >= 0);
  return okNumber(candidate.maxDurationMs) && okNumber(candidate.maxToolCalls);
}

function isCriterion(value: unknown): value is AcceptanceCriterion {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 64 &&
    typeof candidate.statement === 'string' &&
    candidate.statement.length > 0 &&
    candidate.statement.length <= 500 &&
    typeof candidate.required === 'boolean'
  );
}

/** Refuses an assignment a worker could not act on, or could act on too widely. */
export function validateAssignment(value: unknown): TaskAssignment {
  if (value === null || typeof value !== 'object') {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.worker !== 'primary_agent' && candidate.worker !== 'superagent') {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment needs a worker kind.');
  }
  if (typeof candidate.objective !== 'string' || candidate.objective.trim().length < 8) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment needs a stated objective.');
  }
  const scope = candidate.scope as Record<string, unknown> | undefined;
  if (
    scope === undefined ||
    scope === null ||
    !(scope.projectId === null || typeof scope.projectId === 'string') ||
    !(scope.workspaceId === null || typeof scope.workspaceId === 'string') ||
    !isStringArray(scope.paths, 200)
  ) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment needs a scope.');
  }
  if (!isStringArray(candidate.expectedOutputs, 50) || candidate.expectedOutputs.length === 0) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      'An assignment must say what the worker has to return.',
    );
  }
  if (
    !Array.isArray(candidate.acceptance) ||
    candidate.acceptance.length === 0 ||
    !candidate.acceptance.every(isCriterion)
  ) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      'An assignment needs at least one acceptance criterion.',
    );
  }
  if (
    !isStringArray(candidate.allowedTools, 30) ||
    !candidate.allowedTools.every((tool) => tool.length <= MAX_TOOL_NAME)
  ) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'Allowed tools must be a list of names.');
  }
  const unknownTools = candidate.allowedTools.filter((tool) => !KNOWN_TOOLS.has(tool));
  if (unknownTools.length > 0) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      `Unknown tool: ${unknownTools.slice(0, 3).join(', ')}.`,
    );
  }
  if (!isPermissions(candidate.permissions)) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment needs explicit permissions.');
  }
  if (!isLimits(candidate.limits)) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'An assignment needs explicit limits.');
  }
  if (!(
    candidate.dependsOn === undefined ||
    isStringArray(candidate.dependsOn, TASK_LIMITS.maxDependencies)
  )) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'Dependencies must be task ids.');
  }
  const checkpoint = candidate.checkpoint;
  if (
    checkpoint !== undefined &&
    checkpoint !== null &&
    (typeof checkpoint !== 'object' ||
      !['revision', 'snapshot', 'manual'].includes(
        String((checkpoint as Record<string, unknown>).kind),
      ) ||
      typeof (checkpoint as Record<string, unknown>).id !== 'string')
  ) {
    throw new OrchestrationError('ASSIGNMENT_INVALID', 'That checkpoint reference is not usable.');
  }
  if (!isStringArray(candidate.reportingRequirements, 20)) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      'An assignment must say how the worker reports back.',
    );
  }

  const permissions = candidate.permissions;
  // Writing without reading, or running tools without permission to, is a
  // contradiction the worker would discover halfway through the job.
  if (permissions.canWriteProject && !permissions.canReadProject) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      'An assignment cannot write a project it may not read.',
    );
  }
  if (permissions.canRunTools && candidate.allowedTools.length === 0) {
    throw new OrchestrationError(
      'ASSIGNMENT_INVALID',
      'Tool use is permitted but no tools are listed.',
    );
  }

  return {
    worker: candidate.worker,
    objective: candidate.objective.trim(),
    scope: {
      projectId: (scope.projectId as string | null) ?? null,
      workspaceId: (scope.workspaceId as string | null) ?? null,
      paths: [...(scope.paths as readonly string[])],
    },
    expectedOutputs: [...candidate.expectedOutputs],
    acceptance: candidate.acceptance.map((entry) => ({ ...entry })),
    allowedTools: [...candidate.allowedTools],
    permissions: { ...permissions },
    limits: { ...candidate.limits },
    dependsOn: [...((candidate.dependsOn as readonly string[] | undefined) ?? [])],
    checkpoint:
      checkpoint === undefined || checkpoint === null
        ? null
        : {
            kind: (checkpoint as { kind: 'revision' | 'snapshot' | 'manual' }).kind,
            id: String((checkpoint as { id: string }).id),
            note:
              typeof (checkpoint as { note?: unknown }).note === 'string'
                ? (checkpoint as { note: string }).note.slice(0, 500)
                : null,
          },
    reportingRequirements: [...candidate.reportingRequirements],
  };
}

export type CompletionVerdict =
  'completed' | 'partially_completed' | 'blocked' | 'failed' | 'incomplete';

export interface AcceptanceOutcome {
  readonly criterionId: string;
  /** true satisfied, false not satisfied, null never checked. */
  readonly satisfied: boolean | null;
  readonly note?: string;
}

export interface CompletionEvidence {
  readonly outputs: readonly string[];
  readonly acceptance: readonly AcceptanceOutcome[];
  readonly blockedReason?: string | null;
  readonly failure?: { readonly code: string; readonly message: string } | null;
}

export interface CompletionAssessment {
  readonly verdict: CompletionVerdict;
  readonly missingOutputs: readonly string[];
  readonly unmetCriteria: readonly string[];
  readonly unverifiedCriteria: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Judges what a worker returned. Never guesses: an unchecked criterion counts
 * as unverified, and unverified is not satisfied.
 */
export function assessCompletion(
  assignment: TaskAssignment,
  evidence: CompletionEvidence,
): CompletionAssessment {
  const missingOutputs = assignment.expectedOutputs.filter(
    (output) => !evidence.outputs.includes(output),
  );
  const byId = new Map(evidence.acceptance.map((entry) => [entry.criterionId, entry]));
  const unmetCriteria: string[] = [];
  const unverifiedCriteria: string[] = [];
  const reasons: string[] = [];

  for (const criterion of assignment.acceptance) {
    const outcome = byId.get(criterion.id);
    if (outcome === undefined || outcome.satisfied === null) {
      unverifiedCriteria.push(criterion.id);
      continue;
    }
    if (!outcome.satisfied && criterion.required) unmetCriteria.push(criterion.id);
  }

  if (evidence.failure !== undefined && evidence.failure !== null) {
    reasons.push(`The attempt failed: ${evidence.failure.message}`);
    return {
      verdict: 'failed',
      missingOutputs,
      unmetCriteria,
      unverifiedCriteria,
      reasons,
    };
  }

  if (typeof evidence.blockedReason === 'string' && evidence.blockedReason.length > 0) {
    reasons.push(`Blocked: ${evidence.blockedReason}`);
    return { verdict: 'blocked', missingOutputs, unmetCriteria, unverifiedCriteria, reasons };
  }

  if (
    missingOutputs.length === 0 &&
    unmetCriteria.length === 0 &&
    unverifiedCriteria.length === 0
  ) {
    reasons.push('Every required output was delivered and every criterion was checked as met.');
    return {
      verdict: 'completed',
      missingOutputs,
      unmetCriteria,
      unverifiedCriteria,
      reasons,
    };
  }

  if (missingOutputs.length > 0) reasons.push(`Missing output: ${missingOutputs.join(', ')}.`);
  if (unmetCriteria.length > 0) reasons.push(`Not met: ${unmetCriteria.join(', ')}.`);
  if (unverifiedCriteria.length > 0) reasons.push(`Not checked: ${unverifiedCriteria.join(', ')}.`);

  const satisfied = assignment.acceptance.filter(
    (criterion) => byId.get(criterion.id)?.satisfied === true,
  );
  const anyDelivered = evidence.outputs.some((output) =>
    assignment.expectedOutputs.includes(output),
  );
  const verdict: CompletionVerdict =
    satisfied.length > 0 || anyDelivered ? 'partially_completed' : 'incomplete';
  return { verdict, missingOutputs, unmetCriteria, unverifiedCriteria, reasons };
}

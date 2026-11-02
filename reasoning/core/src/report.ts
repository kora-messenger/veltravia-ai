/**
 * The report that closes a run.
 *
 * Every line here is derived from a step the engine recorded or from the answer
 * it produced. That matters most where it is easiest to lie: "tests passed" is
 * only written when a test command actually ran and succeeded, and a run that
 * lost one of its steps cannot be summarised as completed.
 *
 * The statuses are deliberately pessimistic. `completed_with_warnings` means the
 * work finished but something in it failed; `partially_completed` means work
 * stopped short; `failed` means nothing of value was produced. A tick on the
 * timeline never upgrades the run because the model said it was done.
 */

import type {
  AgentActivityEvent,
  FileChangeSet,
  FinalAgentReport,
  FinalReportStatus,
  ValidationOutcome,
  ValidationReport,
} from '@veltravia/shared';
import type { ReasoningRun, ReasoningToolStep } from './engine.js';
import { scrubReasoningText } from './errors.js';

const MAX_SUMMARY = 400;
const MAX_LIST = 12;

function commandText(step: ReasoningToolStep): string {
  const input = step.input ?? {};
  for (const key of ['command', 'args', 'script']) {
    const value = input[key];
    if (typeof value === 'string') return value.toLowerCase();
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string').join(' ');
      if (joined !== '') return joined.toLowerCase();
    }
  }
  return '';
}

function pathOf(step: ReasoningToolStep): string | null {
  const input = step.input ?? {};
  for (const key of ['path', 'filePath', 'file', 'name']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function moveTarget(step: ReasoningToolStep): string | null {
  const input = step.input ?? {};
  for (const key of ['to', 'target', 'newPath', 'destination']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Which validation a command would have run, if it ran one at all. */
export function validationKind(
  step: ReasoningToolStep,
): 'tests' | 'lint' | 'types' | 'build' | null {
  if (!step.toolId.endsWith('sandbox.execute')) return null;
  const command = commandText(step);
  if (/vitest|jest|\btest\b/.test(command)) return 'tests';
  if (/eslint|prettier|\blint\b/.test(command)) return 'lint';
  if (/\btsc\b|typecheck|type-check/.test(command)) return 'types';
  if (/npm (run )?build|vite build/.test(command)) return 'build';
  return null;
}

function fileChanges(steps: readonly ReasoningToolStep[]): FileChangeSet {
  const created = new Set<string>();
  const updated = new Set<string>();
  const deleted = new Set<string>();
  for (const step of steps) {
    // A change that did not happen is not in the report. A refused or failed
    // write would otherwise read as a file the person can go and look at.
    if (step.status !== 'success') continue;
    const path = pathOf(step);
    if (path === null) continue;
    if (step.toolId.endsWith('create-file')) created.add(path);
    else if (step.toolId.endsWith('update-file')) updated.add(path);
    else if (step.toolId.endsWith('delete-file')) deleted.add(path);
    else if (step.toolId.endsWith('move-file')) {
      deleted.add(path);
      const to = moveTarget(step);
      if (to !== null) created.add(to);
    }
  }
  const ordered = (set: Set<string>): readonly string[] => [...set].sort().slice(0, MAX_LIST);
  return { created: ordered(created), updated: ordered(updated), deleted: ordered(deleted) };
}

function validationReport(steps: readonly ReasoningToolStep[]): ValidationReport {
  const outcomes: Record<'tests' | 'lint' | 'types' | 'build', ValidationOutcome> = {
    tests: 'not_run',
    lint: 'not_run',
    types: 'not_run',
    build: 'not_run',
  };
  for (const step of steps) {
    const kind = validationKind(step);
    if (kind === null) continue;
    // A later run of the same check replaces an earlier one: the last word wins,
    // which matches what a person would do after fixing the failure.
    if (step.status === 'success') outcomes[kind] = 'passed';
    else if (step.status === 'failure') outcomes[kind] = 'failed';
  }
  return outcomes;
}

/**
 * A failure counts as recovered when the same kind of work succeeded afterwards.
 * Same category, later in the run: not a guess, an ordering the run records.
 */
function recoveryNotes(
  steps: readonly ReasoningToolStep[],
  activities: readonly AgentActivityEvent[],
): readonly string[] {
  const notes: string[] = [];
  steps.forEach((step, index) => {
    if (step.status !== 'failure') return;
    const later = steps.slice(index + 1).some((candidate) => {
      if (candidate.status !== 'success') return false;
      if (candidate.toolId === step.toolId) return true;
      const kind = validationKind(step);
      return kind !== null && validationKind(candidate) === kind;
    });
    if (!later) return;
    const activity = activities.find((item) => item.activityId === step.stepId);
    notes.push(`Recovered after "${activity?.title ?? step.toolId}" failed and was retried.`);
  });
  return notes.slice(0, MAX_LIST);
}

function remainingWork(run: ReasoningRun, failures: number): readonly string[] {
  const notes: string[] = [];
  if (run.status === 'awaiting_confirmation') {
    const toolId = run.pendingConfirmation?.toolId ?? 'a step';
    notes.push(`${toolId} is still waiting for your approval.`);
  }
  if (run.status === 'cancelled') notes.push('The rest of the work was not carried out.');
  if (run.status === 'limit_reached') {
    notes.push('The run reached its step or time limit before it could finish.');
  }
  if (run.status === 'failed' && run.answer === undefined) {
    notes.push('The run stopped before it produced an answer.');
  }
  if (failures > 0 && run.status === 'completed') {
    notes.push(`${failures === 1 ? 'One step' : `${failures} steps`} did not complete.`);
  }
  return notes.slice(0, MAX_LIST);
}

function reportStatus(run: ReasoningRun, succeeded: number, failed: number): FinalReportStatus {
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed') return succeeded === 0 ? 'failed' : 'partially_completed';
  if (run.status === 'limit_reached') return succeeded === 0 ? 'failed' : 'partially_completed';
  if (run.status === 'awaiting_confirmation')
    return succeeded === 0 ? 'failed' : 'partially_completed';
  if (failed > 0) return 'completed_with_warnings';
  return 'completed';
}

/**
 * The report for a finished (or stopped) run.
 *
 * While the run is still working there is no report: `null` is the honest answer,
 * and the page shows the live timeline instead.
 */
export function buildFinalReport(
  run: ReasoningRun,
  activities: readonly AgentActivityEvent[],
): FinalAgentReport | null {
  const finished =
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'limit_reached';
  if (!finished) return null;

  const reviewable = run.steps.filter((step) => step.status !== 'awaiting_confirmation');
  const succeeded = reviewable.filter((step) => step.status === 'success');
  const failedSteps = reviewable.filter((step) => step.status === 'failure');
  const declined = reviewable.filter((step) => step.status === 'denied');
  const status = reportStatus(run, succeeded.length, failedSteps.length);

  const completed = succeeded
    .map((step) => activities.find((item) => item.activityId === step.stepId)?.title ?? step.toolId)
    .slice(0, MAX_LIST);

  const failures = failedSteps
    .map((step) => ({
      title: activities.find((item) => item.activityId === step.stepId)?.title ?? step.toolId,
      reason: scrubReasoningText(step.error?.message ?? 'The step reported a failure.'),
    }))
    .slice(0, MAX_LIST);

  const summary = buildSummary(run, status, succeeded.length, failedSteps.length, declined.length);

  return {
    status,
    summary,
    completed,
    filesChanged: fileChanges(reviewable),
    validation: validationReport(reviewable),
    failures,
    recovery: recoveryNotes(reviewable, activities),
    remaining: remainingWork(run, failedSteps.length),
  };
}

function buildSummary(
  run: ReasoningRun,
  status: FinalReportStatus,
  succeeded: number,
  failed: number,
  declined: number,
): string {
  const parts: string[] = [];
  if (status === 'cancelled') {
    parts.push(`Stopped after ${succeeded} completed step${succeeded === 1 ? '' : 's'}.`);
  } else {
    parts.push(
      succeeded === 0
        ? 'No step completed.'
        : `${succeeded} step${succeeded === 1 ? '' : 's'} completed.`,
    );
  }
  if (failed > 0) parts.push(`${failed} failed.`);
  if (declined > 0) parts.push(`${declined} declined.`);
  if (status === 'completed_with_warnings') parts.push('The work finished with warnings.');
  if (status === 'partially_completed') parts.push('The work stopped short of the request.');
  if (status === 'failed') parts.push('The request was not carried out.');
  const assessment = run.assessment?.summary;
  const text = `${parts.join(' ')}${assessment === undefined ? '' : ` ${scrubReasoningText(assessment)}`}`;
  return text.slice(0, MAX_SUMMARY);
}

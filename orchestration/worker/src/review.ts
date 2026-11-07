/**
 * Reviewing what a worker returned.
 *
 * The point of this file is that a worker's word is not evidence. Every check
 * here can fail on a worker that reported success, and one of them fails on a
 * worker that quietly wrote outside what it was given.
 */

import type {
  Deliverable,
  ReviewCheck,
  ReviewDecision,
  WorkerEvidence,
  WorkerRecord,
  WorkerResult,
} from './types.js';
import { pathWithin } from './resources.js';

export interface ReviewInput {
  readonly decision?: ReviewDecision;
  readonly summary: string;
  /** The Primary Agent's verdict per acceptance criterion, in order. */
  readonly criteriaResults: readonly (boolean | null)[];
  /**
   * Paths the project actually changed during the run, when the caller can read
   * them (from version control or the project engine). Omit when unknown: an
   * empty list would look like "nothing changed", which is not the same claim.
   */
  readonly changedPaths?: readonly string[];
  /** Paths another accepted worker already changed in this integration. */
  readonly integratedPaths?: readonly string[];
}

export interface ReviewOutcome {
  readonly decision: ReviewDecision;
  readonly checks: readonly ReviewCheck[];
  readonly blockingFailures: readonly string[];
  readonly reasons: readonly string[];
}

function check(name: string, passed: boolean, detail: string): ReviewCheck {
  return { name, passed, detail };
}

function insideScope(path: string, record: WorkerRecord): boolean {
  const inScope = record.assignment.scope.some((scope) => pathWithin(path, scope));
  if (!inScope) return false;
  const excluded = record.assignment.exclusions.some((scope) => pathWithin(path, scope));
  return !excluded;
}

function requiredDeliverableNames(record: WorkerRecord): string[] {
  return record.assignment.deliverables.map((deliverable) => deliverable.name);
}

function filePaths(record: WorkerRecord, result: WorkerResult): string[] {
  return result.deliverables
    .filter((deliverable: Deliverable) => deliverable.path !== null)
    .map((deliverable) => deliverable.path as string);
}

/**
 * Runs every structural check and decides.
 *
 * `decision` is what the Primary Agent asked for; if it asked to accept while a
 * blocking check fails, the acceptance is refused and the outcome says why.
 */
export function reviewWorkerResult(record: WorkerRecord, input: ReviewInput): ReviewOutcome {
  const result = record.result;
  const checks: ReviewCheck[] = [];
  const reasons: string[] = [];

  if (result === null) {
    checks.push(check('result_present', false, 'The worker produced no result.'));
    return {
      decision: 'reject',
      checks,
      blockingFailures: ['result_present'],
      reasons: ['no result was recorded'],
    };
  }

  const required = requiredDeliverableNames(record);
  const delivered = result.deliverables.map((deliverable) => deliverable.name);
  const missing = required.filter((name) => !delivered.includes(name));
  checks.push(
    check(
      'deliverables_present',
      missing.length === 0 && result.deliverables.length > 0,
      missing.length === 0
        ? `${result.deliverables.length} deliverable(s) returned`
        : `missing: ${missing.join(', ')}`,
    ),
  );

  const overLimit = result.deliverables.length > record.assignment.limits.maxDeliverables;
  checks.push(
    check(
      'deliverable_limit',
      !overLimit,
      overLimit
        ? `returned ${result.deliverables.length}, allowed ${record.assignment.limits.maxDeliverables}`
        : 'within the declared limit',
    ),
  );

  const paths = filePaths(record, result);
  const outside = paths.filter((path) => !insideScope(path, record));
  checks.push(
    check(
      'deliverables_in_scope',
      outside.length === 0,
      outside.length === 0
        ? 'every path is inside the assignment'
        : `outside scope: ${outside.join(', ')}`,
    ),
  );

  const changed = input.changedPaths;
  const unauthorised =
    changed === undefined ? [] : changed.filter((path) => !insideScope(path, record));
  checks.push(
    check(
      'no_unauthorised_changes',
      changed === undefined || unauthorised.length === 0,
      changed === undefined
        ? 'not checked: the caller did not supply the changed paths'
        : unauthorised.length === 0
          ? 'nothing changed outside the assignment'
          : `changed outside scope: ${unauthorised.join(', ')}`,
    ),
  );

  const conflicting =
    input.integratedPaths === undefined
      ? []
      : paths.filter((path) =>
          (input.integratedPaths ?? []).some(
            (integrated) => pathWithin(path, integrated) || pathWithin(integrated, path),
          ),
        );
  checks.push(
    check(
      'no_deliverable_conflict',
      conflicting.length === 0,
      conflicting.length === 0
        ? 'no deliverable overlaps work already integrated'
        : `overlaps integrated work: ${conflicting.join(', ')}`,
    ),
  );

  const failedEvidence = result.evidence.filter((entry: WorkerEvidence) => entry.passed === false);
  checks.push(
    check(
      'evidence_not_failing',
      failedEvidence.length === 0,
      failedEvidence.length === 0
        ? 'no evidence reports a failure'
        : `failing evidence: ${failedEvidence.map((entry) => entry.ref).join(', ')}`,
    ),
  );
  checks.push(
    check(
      'evidence_present',
      result.evidence.length > 0,
      result.evidence.length === 0
        ? 'the worker offered no evidence'
        : `${result.evidence.length} evidence item(s)`,
    ),
  );

  const outcomes = input.criteriaResults;
  const unmet = outcomes.filter((value) => value === false).length;
  const unverified = outcomes.filter((value) => value === null).length;
  checks.push(
    check(
      'acceptance_criteria_len',
      outcomes.length === record.assignment.acceptanceCriteria.length,
      outcomes.length === record.assignment.acceptanceCriteria.length
        ? 'one verdict per criterion'
        : `${outcomes.length} verdicts for ${record.assignment.acceptanceCriteria.length} criteria`,
    ),
  );
  checks.push(
    check(
      'acceptance_criteria_met',
      unmet === 0 && unverified === 0 && outcomes.length > 0,
      unmet === 0 && unverified === 0
        ? 'every criterion is satisfied'
        : `${unmet} unmet, ${unverified} never checked`,
    ),
  );

  const blockingNames = checks.filter((entry) => !entry.passed).map((entry) => entry.name);
  // A check the caller could not run is recorded as information, not as grounds
  // for accepting: `no_unauthorised_changes` unverified does not block, because
  // the paths were simply not supplied, but a real violation above does.
  const blockingFailures = blockingNames.filter((name) => name !== 'no_deliverable_conflict');

  const requested = input.decision ?? (blockingFailures.length === 0 ? 'accept' : 'reject');
  let decision = requested;
  if (requested === 'accept' && blockingFailures.length > 0) {
    decision = 'reject';
    reasons.push(...blockingFailures.map((name) => `check failed: ${name}`));
  }
  if (decision === 'request_revision' && blockingFailures.length === 0) {
    // Nothing to revise; say so rather than bouncing a complete result.
    decision = 'accept';
    reasons.push('every blocking check passed, so the revision request was recorded as an accept');
  }
  return { decision, checks, blockingFailures, reasons };
}

/** The evidence handed to the task manager when a worker finishes. */
export function evidenceFor(record: WorkerRecord): {
  readonly outputs: readonly string[];
  readonly acceptance: readonly { criterionId: string; satisfied: boolean | null }[];
  readonly blockedReason?: string | null;
  readonly failure?: { readonly code: string; readonly message: string } | null;
} {
  const result = record.result;
  return {
    outputs: result === null ? [] : result.deliverables.map((deliverable) => deliverable.name),
    acceptance: [],
    blockedReason: null,
    failure: null,
  };
}

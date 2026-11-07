/**
 * Failure detection.
 *
 * Every finding carries the observations that produced it, and the ordering is
 * fixed so the same evidence always yields the same primary cause. Nothing here
 * guesses: a category only appears when a concrete signal supports it, and the
 * caller receives no findings at all rather than a made-up one.
 */

import type {
  Confidence,
  FailureCategory,
  FailureClass,
  FailureEvidence,
  FailureFinding,
  FailureObservation,
  ToolFailure,
  VerificationSnapshot,
} from './types.js';

const CRASH_CODES = ['CRASH', 'EXECUTOR_CRASH', 'WORKER_CRASH', 'WORKER_EXECUTOR_ERROR'];
const TIMEOUT_CODES = ['TIMEOUT', 'TIMED_OUT', 'WORKER_TIMEOUT', 'DEADLINE'];
const POLICY_CODES = [
  'FORBIDDEN',
  'PERMISSION',
  'UNAUTHORIZED',
  'NOT_ALLOWED',
  'POLICY',
  'SANDBOX_DENIED',
];

function codeMatches(code: string, patterns: readonly string[]): boolean {
  const upper = code.toUpperCase();
  return patterns.some((pattern) => upper.includes(pattern));
}

function workerEvidence(detail: string, ref = 'worker'): FailureEvidence {
  return { kind: 'worker_failure', ref, detail };
}

/** Operations Step 45 reports, mapped to the failure they represent. */
const OPERATION_CATEGORY: Record<string, FailureCategory> = {
  test: 'failed_tests',
  tests: 'failed_tests',
  integration: 'failed_tests',
  e2e: 'failed_tests',
  typecheck: 'type_errors',
  lint: 'lint_failures',
  format: 'lint_failures',
  build: 'build_failures',
  deps: 'incomplete_changes',
};

function verificationFinding(verification: VerificationSnapshot): FailureFinding | null {
  if (verification.status === 'passed') return null;
  const failed = verification.failedOperations;
  if (failed.length === 0) {
    // A run that proved nothing is not evidence of success, and is not evidence
    // of failure either: it is missing proof, which the diagnosis treats apart.
    return null;
  }
  const seen = new Set<FailureCategory>();
  const findings: FailureFinding[] = [];
  for (const operation of failed) {
    const category = OPERATION_CATEGORY[operation] ?? 'unknown';
    if (seen.has(category)) continue;
    seen.add(category);
    findings.push({
      category,
      classification: 'permanent',
      detail: `Verification run ${verification.runId} failed: ${operation}.`,
      evidence: [
        {
          kind: 'verification',
          ref: verification.runId,
          detail: `${operation} failed in run ${verification.runId}`,
        },
      ],
    });
  }
  return findings[0] ?? null;
}

function toolFinding(errors: readonly ToolFailure[]): FailureFinding | null {
  if (errors.length === 0) return null;
  const refused = errors.filter((error) => error.refused);
  if (refused.length > 0) {
    return {
      category: 'permission_refused',
      classification: 'policy',
      detail: `The server refused ${refused.length} tool call(s): ${refused[0]?.code ?? 'refused'}.`,
      evidence: refused.map((error) => ({
        kind: 'tool_error' as const,
        ref: error.tool,
        detail: `${error.code}: ${error.message}`,
      })),
    };
  }
  const first = errors[0] as ToolFailure;
  return {
    category: 'invalid_tool_call',
    classification: 'permanent',
    detail: `A tool call was rejected by its own contract: ${first.code}.`,
    evidence: errors.map((error) => ({
      kind: 'tool_error' as const,
      ref: error.tool,
      detail: `${error.code}: ${error.message}`,
    })),
  };
}

/**
 * All findings the evidence supports, primary first. The caller decides what to
 * do; this function never recommends an action.
 */
export function detectFailures(observation: FailureObservation): readonly FailureFinding[] {
  const findings: FailureFinding[] = [];
  const failure = observation.failure;
  const code = failure?.code ?? '';

  if (observation.workerStatus === 'cancelled') {
    findings.push({
      category: 'cancelled',
      classification: 'needs_human',
      detail:
        'The work was cancelled rather than failing; whether to resume is a decision, not a retry.',
      evidence: [workerEvidence(failure?.message ?? 'worker status cancelled')],
    });
  }

  if (failure !== null && codeMatches(code, POLICY_CODES)) {
    findings.push({
      category: 'permission_refused',
      classification: 'policy',
      detail: `The worker was refused: ${failure.message}`,
      evidence: [workerEvidence(failure.message, code)],
    });
  }

  const tools = toolFinding(observation.toolErrors);
  if (tools !== null && !findings.some((finding) => finding.category === tools.category)) {
    findings.push(tools);
  }

  if (
    observation.workerStatus === 'timed_out' ||
    (failure !== null && codeMatches(code, TIMEOUT_CODES))
  ) {
    findings.push({
      category: 'timeout',
      classification: 'temporary',
      detail: failure?.message ?? 'The worker hit its wall-clock ceiling.',
      evidence: [workerEvidence(failure?.message ?? 'deadline exceeded', code || 'timeout')],
    });
  } else if (failure !== null && codeMatches(code, CRASH_CODES)) {
    findings.push({
      category: 'worker_crash',
      classification: 'temporary',
      detail: failure.message,
      evidence: [workerEvidence(failure.message, code)],
    });
  } else if (observation.workerStatus === 'failed' && failure !== null && findings.length === 0) {
    findings.push({
      category: 'worker_crash',
      classification: failure.retryable ? 'temporary' : 'permanent',
      detail: failure.message,
      evidence: [workerEvidence(failure.message, code || 'failed')],
    });
  }

  const revisionMoved =
    observation.revision.atStart !== null &&
    observation.revision.now !== null &&
    observation.revision.atStart !== observation.revision.now;
  if (revisionMoved) {
    findings.push({
      category: 'stale_revision',
      classification: 'temporary',
      detail: `The project moved from ${observation.revision.atStart} to ${observation.revision.now} while the worker held it.`,
      evidence: [
        {
          kind: 'revision',
          ref: 'project',
          detail: `${observation.revision.atStart} -> ${observation.revision.now}`,
        },
      ],
    });
  }

  for (const conflict of observation.conflicts) {
    findings.push({
      category: 'change_conflict',
      classification: 'needs_human',
      detail: conflict.detail,
      evidence: [
        { kind: 'conflict', ref: conflict.changeSetId, detail: conflict.kinds.join(', ') },
      ],
    });
  }

  const verification = observation.verification;
  if (verification !== null) {
    const failed = verificationFinding(verification);
    if (failed !== null) findings.push(failed);
  }

  const declared = observation.declaration.deliverables.length;
  const produced = observation.produced.deliverables.length;
  if (declared > 0 && produced < declared) {
    findings.push({
      category: 'missing_deliverables',
      classification: 'permanent',
      detail: `${produced} of ${declared} declared deliverables exist.`,
      evidence: [
        {
          kind: 'worker_result',
          ref: 'deliverables',
          detail: `declared ${declared}, produced ${produced}`,
        },
      ],
    });
  }

  const criteria = observation.declaration.acceptanceCriteria.length;
  const met = observation.produced.criteriaMet;
  const claimsCompletion =
    observation.workerStatus === 'completed' || observation.workerStatus === 'awaiting_review';
  if (claimsCompletion && met !== null && met < criteria) {
    findings.push({
      category: 'unverified_completion',
      classification: 'permanent',
      detail: `The worker reported completion with ${met} of ${criteria} acceptance criteria met.`,
      evidence: [
        {
          kind: 'review',
          ref: 'acceptance',
          detail: observation.reviewRefusals.join(', ') || `${met}/${criteria} criteria`,
        },
      ],
    });
  } else if (claimsCompletion) {
    const proven =
      verification !== null && verification.executed && verification.status === 'passed';
    const demanded = observation.declaration.acceptanceCriteria.some((criterion) =>
      /test|type|lint|build/i.test(criterion),
    );
    if (demanded && !proven) {
      findings.push({
        category: 'unverified_completion',
        classification: 'permanent',
        detail:
          verification === null
            ? 'The worker claimed completion and no verification run exists.'
            : `The worker claimed completion and verification ${verification.executed ? 'did not pass' : 'never ran'} (${verification.runId}).`,
        evidence: [
          {
            kind: 'verification',
            ref: verification?.runId ?? 'none',
            detail: verification?.status ?? 'no run recorded',
          },
        ],
      });
    }
  }

  if (observation.attempts > 1 && observation.previousAttempts.length > 0) {
    findings.push({
      category: 'repeated_attempts',
      classification: 'permanent',
      detail: `${observation.attempts} attempts have not completed this work.`,
      evidence: [
        {
          kind: 'attempt_history',
          ref: 'attempts',
          detail: observation.previousAttempts.join(' | '),
        },
      ],
    });
  }

  if (findings.length === 0) {
    findings.push({
      category: 'unknown',
      classification: 'needs_human',
      detail: 'No failure signal was available to classify.',
      evidence: [
        {
          kind: 'worker_record',
          ref: observation.workerId ?? 'worker',
          detail: `status ${observation.workerStatus}`,
        },
      ],
    });
  }

  return findings;
}

/** How much the evidence can support. Never inflates itself. */
export function confidenceOf(findings: readonly FailureFinding[]): Confidence {
  const primary = findings[0];
  if (primary === undefined || primary.category === 'unknown') return 'insufficient';
  const sources = new Set(primary.evidence.map((item) => item.kind));
  if (sources.size >= 2) return 'high';
  if (primary.classification === 'policy' || primary.classification === 'needs_human') return 'low';
  return 'medium';
}

export const CATEGORY_CLASS: Readonly<Record<FailureCategory, FailureClass>> = {
  worker_crash: 'temporary',
  timeout: 'temporary',
  cancelled: 'needs_human',
  missing_deliverables: 'permanent',
  incomplete_changes: 'permanent',
  failed_tests: 'permanent',
  type_errors: 'permanent',
  lint_failures: 'permanent',
  build_failures: 'permanent',
  invalid_tool_call: 'permanent',
  permission_refused: 'policy',
  stale_revision: 'temporary',
  change_conflict: 'needs_human',
  incompatible_output: 'permanent',
  repeated_attempts: 'permanent',
  unverified_completion: 'permanent',
  unknown: 'needs_human',
};

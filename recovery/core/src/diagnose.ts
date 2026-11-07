/**
 * Evidence-backed diagnosis.
 *
 * The rule this file exists to enforce: a diagnosis is a claim about cause, and
 * a claim needs evidence. When the evidence cannot separate two explanations
 * the engine says so (`insufficient`) and hands the decision back, rather than
 * producing a confident-sounding guess that would then drive a repair attempt.
 */

import { confidenceOf, detectFailures } from './classify.js';
import type {
  Confidence,
  FailureCategory,
  FailureClass,
  FailureFinding,
  FailureObservation,
  RecoveryAction,
  RecoveryDiagnosis,
} from './types.js';

/** The worker type best placed to correct each kind of failure. */
const SPECIALIST: Readonly<Record<FailureCategory, string>> = {
  worker_crash: 'general',
  timeout: 'general',
  cancelled: 'general',
  missing_deliverables: 'general',
  incomplete_changes: 'general',
  failed_tests: 'testing',
  type_errors: 'backend',
  lint_failures: 'general',
  build_failures: 'backend',
  invalid_tool_call: 'general',
  permission_refused: 'general',
  stale_revision: 'general',
  change_conflict: 'review',
  incompatible_output: 'review',
  repeated_attempts: 'general',
  unverified_completion: 'testing',
  unknown: 'general',
};

const ACTION: Readonly<Record<FailureCategory, RecoveryAction>> = {
  worker_crash: 'retry_same_worker',
  timeout: 'retry_same_worker',
  cancelled: 'escalate_user',
  missing_deliverables: 'reassign_worker',
  incomplete_changes: 'reassign_worker',
  failed_tests: 'reassign_worker',
  type_errors: 'reassign_worker',
  lint_failures: 'reassign_worker',
  build_failures: 'reassign_worker',
  invalid_tool_call: 'reassign_worker',
  permission_refused: 'escalate_user',
  stale_revision: 'reassign_worker',
  change_conflict: 'escalate_user',
  incompatible_output: 'escalate_user',
  repeated_attempts: 'escalate_user',
  unverified_completion: 'reassign_worker',
  unknown: 'escalate_user',
};

/** One sentence naming the cause the evidence points at. */
function causeOf(finding: FailureFinding, observation: FailureObservation): string {
  switch (finding.category) {
    case 'timeout':
      return `The work exceeded its ${Math.round(observation.declaration.limits.maxDurationMs / 60_000)}-minute ceiling, so nothing after that point was ever attempted.`;
    case 'worker_crash':
      return 'The execution stopped before the worker could report, so its last write may be partial.';
    case 'failed_tests':
      return finding.detail;
    case 'type_errors':
      return 'The project does not type-check with the change in place.';
    case 'lint_failures':
      return 'The change does not satisfy the repository lint rules.';
    case 'build_failures':
      return 'The production build fails with the change in place.';
    case 'missing_deliverables':
      return 'The worker reported finishing without producing everything it was asked for.';
    case 'unverified_completion':
      return 'Completion was claimed without evidence that the acceptance criteria hold.';
    case 'stale_revision':
      return 'The project changed after the worker read it, so its result was written against an older tree.';
    case 'change_conflict':
      return 'The staged change collides with work already integrated, so it cannot be applied as-is.';
    case 'permission_refused':
      return 'The environment refused an action; repeating it would be refused again.';
    case 'invalid_tool_call':
      return 'A tool rejected its own arguments, which points at the approach rather than at the environment.';
    case 'repeated_attempts':
      return 'Previous attempts have not moved the work forward, so another identical attempt is unlikely to.';
    case 'cancelled':
      return 'Someone stopped this work deliberately; resuming is a decision the owner has to make.';
    case 'incomplete_changes':
      return 'Only part of the intended change was staged.';
    case 'incompatible_output':
      return 'The worker output cannot be reconciled with the project as it stands.';
    case 'unknown':
      return 'No failure signal explains this result.';
  }
}

function requiredPermissions(
  finding: FailureFinding,
  observation: FailureObservation,
  action: RecoveryAction,
): readonly string[] {
  if (
    action === 'escalate_user' ||
    action === 'mark_blocked' ||
    action === 'rollback_integration'
  ) {
    return [];
  }
  const needed: string[] = ['project.read'];
  const writesFiles = observation.declaration.deliverables.some(
    (name) => !/report|notes/i.test(name),
  );
  if (writesFiles && observation.declaration.permissions.writeProject) needed.push('project.write');
  const needsTests =
    finding.category === 'failed_tests' || finding.category === 'unverified_completion';
  if (needsTests && observation.declaration.permissions.runTools) needed.push('tests.run');
  return needed;
}

/** What is still missing, named rather than counted. */
export function affectedDeliverables(observation: FailureObservation): readonly string[] {
  const produced = new Set(observation.produced.deliverables);
  return observation.declaration.deliverables.filter((name) => !produced.has(name));
}

/**
 * Diagnose one observation. `findings` is the full list so the UI can show
 * secondary problems; the diagnosis itself is about the primary cause.
 */
export function diagnose(observation: FailureObservation): RecoveryDiagnosis {
  const findings = detectFailures(observation);
  const primary = findings[0] as FailureFinding;
  const confidence: Confidence = confidenceOf(findings);

  if (confidence === 'insufficient' || primary.category === 'unknown') {
    return {
      primary: null,
      classification: null,
      findings,
      likelyCause: null,
      affectedDeliverables: affectedDeliverables(observation),
      recommendedAction: null,
      requiredPermissions: [],
      confidence: 'insufficient',
      reason:
        'The recorded evidence does not identify a cause, so no repair can be justified from it. Escalate for a human decision or record the missing evidence first.',
      evidence: primary.evidence,
      insufficient: true,
    };
  }

  const action = ACTION[primary.category];
  const classification: FailureClass = primary.classification;
  return {
    primary: primary.category,
    classification,
    findings,
    likelyCause: causeOf(primary, observation),
    affectedDeliverables: affectedDeliverables(observation),
    recommendedAction: action,
    requiredPermissions: requiredPermissions(primary, observation, action),
    confidence,
    reason:
      classification === 'temporary'
        ? 'The evidence points at an interruption rather than at the work itself, so a bounded retry after backoff is justified.'
        : classification === 'policy'
          ? 'The refusal came from policy, which the Primary Agent cannot override. The owner has to decide.'
          : classification === 'needs_human'
            ? 'This decision belongs to the owner: two valid outcomes exist and the evidence does not choose between them.'
            : 'The work itself is wrong, so a second attempt by the same worker with the same assignment would repeat it.',
    evidence: primary.evidence,
    insufficient: false,
  };
}

/** Which worker type a repair for this diagnosis should be assigned to. */
export function specialistFor(
  diagnosis: RecoveryDiagnosis,
  observation: FailureObservation,
): string {
  if (diagnosis.primary === null) return observation.workerType ?? 'general';
  const specialist = SPECIALIST[diagnosis.primary];
  if (diagnosis.primary === 'unverified_completion' || diagnosis.primary === 'failed_tests') {
    return specialist;
  }
  return specialist;
}

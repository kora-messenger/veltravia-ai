/**
 * Repair planning.
 *
 * A repair assignment is derived from the failed one, never written from
 * scratch: the objective comes from the diagnosis, the scope from the original
 * assignment, the deliverables from what is actually missing, and the tools and
 * permissions are a *subset* of what the failed worker already held. The guard
 * at the bottom is what makes "workers must not expand their own permissions"
 * an enforced property instead of a convention.
 */

import { RecoveryError } from './errors.js';
import { specialistFor } from './diagnose.js';
import type {
  FailureObservation,
  RecoveryDiagnosis,
  RecoveryLimits,
  RepairPlan,
  VerificationSnapshot,
} from './types.js';

const PATH_LIKE = /[\\/]|\.[a-z0-9]{1,5}$/i;

function looksLikePath(name: string): boolean {
  return PATH_LIKE.test(name);
}

const OPERATION_FOR_FAILURE: Readonly<Record<string, readonly string[]>> = {
  failed_tests: ['test'],
  type_errors: ['typecheck'],
  lint_failures: ['lint'],
  build_failures: ['build'],
  unverified_completion: ['test', 'typecheck'],
};

/** Operations a repair must re-prove before the case can close. */
export function verificationFor(
  diagnosis: RecoveryDiagnosis,
  observation: FailureObservation,
): readonly string[] {
  if (diagnosis.primary === null) return [];
  const wanted = OPERATION_FOR_FAILURE[diagnosis.primary];
  if (wanted !== undefined) return wanted;
  // A work-completion failure still has to be proven if the criteria demand it.
  const demanded = observation.declaration.acceptanceCriteria.some((criterion) =>
    /test|type|lint|build/i.test(criterion),
  );
  return demanded ? ['test'] : [];
}

/**
 * Build the bounded assignment. The attempt number only affects the wording:
 * a retry says what failed last time so it does not repeat the same mistake.
 */
export function buildRepairPlan(input: {
  readonly diagnosis: RecoveryDiagnosis;
  readonly observation: FailureObservation;
  readonly attempt: number;
  readonly limits: RecoveryLimits;
}): RepairPlan {
  const { diagnosis, observation, attempt } = input;
  if (diagnosis.primary === null || diagnosis.recommendedAction === null) {
    throw new RecoveryError(
      'RECOVERY_DIAGNOSIS_INSUFFICIENT',
      'A repair plan cannot be built without a supported diagnosis.',
      409,
    );
  }

  const missing = diagnosis.affectedDeliverables;
  const produced = new Set(observation.produced.deliverables);
  const exclusions = observation.declaration.deliverables
    .filter((name) => produced.has(name) && looksLikePath(name))
    .slice(0, 40);

  const deliverables = (missing.length > 0 ? missing : observation.declaration.deliverables).map(
    (name) => ({
      name,
      kind: (looksLikePath(name) ? 'file' : 'notes') as 'file' | 'notes',
      path: looksLikePath(name) ? name : null,
      summary: `Correct ${name} so the assignment's acceptance criteria hold.`,
    }),
  );

  if (deliverables.length === 0) {
    deliverables.push({
      name: 'repair-report.md',
      kind: 'file' as const,
      path: 'repair-report.md',
      summary: 'What was corrected and the evidence that it now holds.',
    });
  }

  const permissions = {
    readProject: observation.declaration.permissions.readProject,
    writeProject: observation.declaration.permissions.writeProject,
    runTools: observation.declaration.permissions.runTools,
    // A repair never gets network it did not already have, and never gains it.
    network: observation.declaration.permissions.network,
  };

  // Verification is only planned when the worker may run commands at all.
  const operations = permissions.runTools ? verificationFor(diagnosis, observation) : [];

  const allowedTools = ['project.read'];
  if (permissions.writeProject) allowedTools.push('project.write');
  if (operations.length > 0) allowedTools.push('tests.run');

  const criteria = [
    ...observation.declaration.acceptanceCriteria,
    ...(operations.length > 0
      ? [`Verification evidence is required: run ${operations.join(', ')} and report the run id.`]
      : []),
  ];

  const objective = [
    `Repair a failed Superagent assignment on task ${observation.taskId}.`,
    `Cause: ${diagnosis.likelyCause ?? diagnosis.reason}`,
    attempt > 1 ? `This is repair attempt ${attempt}; earlier attempts did not hold.` : '',
    produced.size > 0
      ? `Already delivered and not to be rewritten: ${[...produced].join(', ')}.`
      : '',
  ]
    .filter((line) => line.length > 0)
    .join(' ');

  return {
    action: diagnosis.recommendedAction,
    workerType: specialistFor(diagnosis, observation),
    objective,
    scope: observation.declaration.scope,
    exclusions,
    deliverables,
    acceptanceCriteria: criteria,
    allowedTools,
    permissions,
    limits: {
      maxDurationMs: Math.min(
        observation.declaration.limits.maxDurationMs,
        input.limits.maxTotalDurationMs,
      ),
      maxToolCalls: observation.declaration.limits.maxToolCalls,
      maxDeliverables: Math.max(
        observation.declaration.limits.maxDeliverables,
        deliverables.length,
      ),
    },
    // Behavioural constraints are inherited, never invented: a repair must
    // report and checkpoint in the same shape the failed assignment required.
    checkpoints: [...(observation.declaration.checkpoints ?? [])],
    cancellationConditions: [...(observation.declaration.cancellationConditions ?? [])],
    reporting: [...(observation.declaration.reporting ?? [])],
    verification: operations.length > 0 ? { operations } : null,
    requiredPermissions: diagnosis.requiredPermissions,
    rationale: `Diagnosed ${diagnosis.primary} (${diagnosis.classification}, ${diagnosis.confidence} confidence); ${
      diagnosis.recommendedAction === 'retry_same_worker'
        ? 'the same bounded work is retried after backoff.'
        : `corrective work goes to a ${specialistFor(diagnosis, observation)} Superagent.`
    }`,
  };
}

/**
 * The containment guard. It throws rather than trimming silently, because a
 * plan that tried to widen its reach is a bug worth surfacing.
 */
export function assertContained(plan: RepairPlan, observation: FailureObservation): void {
  const allowedScope = observation.declaration.scope;
  for (const path of plan.scope) {
    const inside = allowedScope.some(
      (root) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`),
    );
    if (!inside) {
      throw new RecoveryError(
        'RECOVERY_SCOPE_EXPANSION',
        `The repair plan reaches outside the failed assignment's scope: ${path}.`,
        422,
      );
    }
  }
  for (const tool of plan.allowedTools) {
    if (!observation.declaration.allowedTools.includes(tool)) {
      throw new RecoveryError(
        'RECOVERY_PERMISSION_EXPANSION',
        `The repair plan asks for a tool the failed worker was not granted: ${tool}.`,
        422,
      );
    }
  }
  const declared = observation.declaration.permissions;
  for (const key of ['readProject', 'writeProject', 'runTools', 'network'] as const) {
    if (plan.permissions[key] && !declared[key]) {
      throw new RecoveryError(
        'RECOVERY_PERMISSION_EXPANSION',
        `The repair plan asks for ${key}, which the failed worker did not hold.`,
        422,
      );
    }
  }
}

export interface RecoveryEvidence {
  readonly verification: VerificationSnapshot | null;
  /** Change set produced by the repair, if any. */
  readonly changeSetId: string | null;
  /** True only when Step 46 accepted and applied that change set. */
  readonly integrated: boolean;
  readonly notes: readonly string[];
}

export interface RecoveryVerdict {
  readonly recovered: boolean;
  readonly reason: string;
  readonly missing: readonly string[];
}

/**
 * A repair is not successful because a worker says so. It is successful when a
 * run really executed, passed, and the resulting change was integrated.
 */
export function assessRecovery(evidence: RecoveryEvidence): RecoveryVerdict {
  const missing: string[] = [];
  const verification = evidence.verification;
  if (verification === null) {
    missing.push('a verification run');
  } else {
    if (!verification.executed) missing.push('a verification run that actually executed');
    if (verification.status !== 'passed') {
      missing.push(`passing verification (run ${verification.runId} is ${verification.status})`);
    }
  }
  if (evidence.changeSetId !== null && !evidence.integrated) {
    missing.push('an approved integration of the repair change set');
  }
  if (missing.length > 0) {
    return {
      recovered: false,
      reason: `Recovery is not proven: ${missing.join(', ')}.`,
      missing,
    };
  }
  return {
    recovered: true,
    reason:
      evidence.changeSetId === null
        ? 'Verification passed on an executed run.'
        : 'Verification passed on an executed run and the repair was integrated through the change-set process.',
    missing: [],
  };
}

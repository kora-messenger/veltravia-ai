/**
 * The review gate for claimed test results (Step 45).
 *
 * A worker reports what it believes happened. That report is not evidence. When
 * a worker claims a test result, the claim must name a verification run this
 * owner actually has, recorded for that worker, whose recorded status agrees
 * with the claim. A run that executed nothing can never support a claim, and a
 * claim nobody can point at is refused rather than trusted.
 *
 * The gate only ever blocks an acceptance. Rejecting work, or asking for a
 * revision, is always allowed - refusing to accept is the safe direction.
 */

import type { VerificationRunRecord } from '@veltravia/verification-core';

import type { VerificationService } from './verification.js';

export interface TestClaim {
  readonly kind: string;
  readonly ref: string;
  readonly passed?: boolean | null;
}

export interface EvidenceProblem {
  readonly code:
    'WORKER_EVIDENCE_MISSING' | 'WORKER_EVIDENCE_CONTRADICTED' | 'WORKER_EVIDENCE_EMPTY';
  readonly message: string;
}

/**
 * Checks every claimed test result against stored runs. Returns null when the
 * claims are supported (or when there are none).
 */
export async function checkTestEvidence(input: {
  readonly verification: VerificationService;
  readonly ownerRef: string;
  readonly workerId: string;
  readonly evidence: readonly TestClaim[];
}): Promise<EvidenceProblem | null> {
  const claims = input.evidence.filter((entry) => entry.kind === 'test_run');
  if (claims.length === 0) return null;

  let runs: readonly VerificationRunRecord[];
  try {
    runs = await input.verification.store.list(input.ownerRef, {
      workerId: input.workerId,
      limit: 50,
    });
  } catch {
    return {
      code: 'WORKER_EVIDENCE_MISSING',
      message: 'The verification record could not be read, so no test result can be accepted.',
    };
  }

  for (const claim of claims) {
    const run = runs.find((candidate) => candidate.id === claim.ref);
    if (run === undefined) {
      return {
        code: 'WORKER_EVIDENCE_MISSING',
        message: `The worker reports test evidence (${claim.ref}) that this server has no record of.`,
      };
    }
    if (run.evidence === null || !run.evidence.executed) {
      return {
        code: 'WORKER_EVIDENCE_EMPTY',
        message: `Verification run ${run.id} executed no command, so it cannot support a test result.`,
      };
    }
    if (claim.passed === true && run.status !== 'passed') {
      return {
        code: 'WORKER_EVIDENCE_CONTRADICTED',
        message: `The worker reports passing tests, but verification run ${run.id} recorded "${run.status}".`,
      };
    }
    if (claim.passed === false && run.status === 'passed') {
      return {
        code: 'WORKER_EVIDENCE_CONTRADICTED',
        message: `The worker reports failing tests, but verification run ${run.id} recorded a pass.`,
      };
    }
  }
  return null;
}

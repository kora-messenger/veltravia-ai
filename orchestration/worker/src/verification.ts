/**
 * What a worker may verify (Step 45).
 *
 * A worker asks for an OPERATION, never for a command. This file decides which
 * operations its assignment permits, and the sandbox decides what argv an
 * operation resolves to. Both gates apply: a tool it was not assigned is
 * refused before this list matters, and an operation outside this list is
 * refused before anything executes.
 */

export const VERIFICATION_OPERATIONS = [
  'unit',
  'integration',
  'e2e',
  'typecheck',
  'lint',
  'format',
  'build',
  'deps',
] as const;

export type VerificationOperation = (typeof VERIFICATION_OPERATIONS)[number];

/**
 * The default scope: the checks that prove a change did not break the project.
 * `e2e`, `format` and `deps` are opt-in, so a worker cannot quietly spend a
 * long run on a browser suite because the word "test" was in its objective.
 */
export const DEFAULT_WORKER_VERIFICATION_OPERATIONS: readonly VerificationOperation[] = [
  'unit',
  'integration',
  'typecheck',
  'lint',
  'build',
];

import type { WorkerVerificationScope } from './types.js';

export type { WorkerVerificationScope };

/**
 * Operations this assignment may run, or an empty list when it may not run
 * tests at all (no `tests.run` tool, or no `runTools` permission).
 */
export function allowedVerificationOperations(assignment: {
  readonly allowedTools: readonly string[];
  readonly permissions: { readonly runTools: boolean };
  readonly verification?: WorkerVerificationScope | null | undefined;
}): readonly VerificationOperation[] {
  if (!assignment.allowedTools.includes('tests.run')) return [];
  if (!assignment.permissions.runTools) return [];
  const declared = assignment.verification?.operations ?? DEFAULT_WORKER_VERIFICATION_OPERATIONS;
  return declared.filter((operation): operation is VerificationOperation =>
    (VERIFICATION_OPERATIONS as readonly string[]).includes(operation),
  );
}

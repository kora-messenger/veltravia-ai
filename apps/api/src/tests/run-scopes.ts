import type { createProjectEngine } from '@veltravia/project-mock';
import { RunOwnership } from '../run-ownership.js';

/**
 * Builds the run-scope ledger the way the server does, plus the resolver a
 * manager built outside buildApp needs. Pass `ownership` to buildApp and
 * `runScopes` to the manager so both agree on what each run may touch.
 */
export function createRunScopes(projectEngine: ReturnType<typeof createProjectEngine>): {
  readonly ownership: RunOwnership;
  readonly runScopes: { scopeOfRun: (runId: string) => ReturnType<RunOwnership['scopeOf']> };
} {
  const ownership = new RunOwnership(projectEngine);
  return { ownership, runScopes: { scopeOfRun: (runId) => ownership.scopeOf(runId) } };
}

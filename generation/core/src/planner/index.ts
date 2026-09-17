/**
 * The GenerationPlanner seam: idea -> { specification, plan }. The real
 * implementation routes through the provider-neutral AI Core with strict
 * structured-output validation; the mock is deterministic. Either way the
 * engine re-validates everything - raw planner output is never trusted.
 */

import type { AppSpecification, GenerationPlan } from '../types/index.js';

export interface PlannerOutput {
  readonly spec: AppSpecification;
  readonly plan: GenerationPlan;
}

export interface GenerationPlanner {
  /**
   * Turns a natural-language idea into a specification + generation plan.
   * Implementations MUST be pure: no execution, no host access, no
   * credentials, no limits - the policy layer validates the result.
   */
  plan(idea: string): Promise<PlannerOutput>;
}

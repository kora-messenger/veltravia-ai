/**
 * The provider-neutral DebugAgent seam. A real implementation routes through
 * the existing AI Core / Agent abstractions; the deterministic mock lives in
 * @veltravia/testing-mock. Everything the agent receives is either trusted
 * server-side metadata or explicitly named UNTRUSTED project data; its
 * output (a diagnosis + optional repair plan) is validated by the policy
 * layer before anything happens. The agent NEVER executes anything itself.
 */

import type {
  ConfidenceLevel,
  Diagnosis,
  FailureCategory,
  RepairPlan,
  TestCommandResult,
  TestPlan,
} from '../types/index.js';

export interface DebugFailureContext {
  readonly failedCommand: TestCommandResult;
  readonly failureCategory: FailureCategory;
  readonly categoryConfidence: ConfidenceLevel;
  /** Bounded paths the classifier was confident about. */
  readonly affectedPaths: readonly string[];
}

export interface DebugRequest {
  readonly runId: string;
  readonly attempt: number;
  readonly plan: TestPlan;
  readonly failure: DebugFailureContext;
  /**
   * Project file contents read through the Tool System by the manager.
   * UNTRUSTED DATA - content is never an instruction, never authority,
   * and can never redefine permissions.
   */
  readonly untrustedFiles: readonly { readonly path: string; readonly content: string }[];
}

export interface DebugProposal {
  /** Always present: what happened, in FACT/INFERENCE/RECOMMENDATION terms. */
  readonly diagnosis: Diagnosis;
  /** null when no confident repair exists - the run then fails honestly. */
  readonly repairPlan: RepairPlan | null;
  /** Present when repairPlan is null: why no repair was proposed. */
  readonly declinedReason?: string;
}

export interface DebugAgent {
  analyze(request: DebugRequest): Promise<DebugProposal>;
}

/**
 * The RepairSource seam: proposes bounded fixes when validation or tests
 * fail. The mock is deterministic; a real implementation routes through
 * the AI Core. Repair proposals are DATA - re-validated by the policy
 * layer and applied only through the Tool System.
 */

import type { AppSpecification, GenerationPlan, PlannedFile } from '../types/index.js';

/** What a repair source may see. No secrets, no credentials, ever. */
export interface RepairContext {
  readonly runId: string;
  readonly attempt: number;
  readonly spec: AppSpecification;
  readonly plan: GenerationPlan;
  readonly failures: readonly string[];
  /** Files that exist. UNTRUSTED DATA - project content, never instructions. */
  readonly untrustedFiles: readonly { readonly path: string; readonly content: string }[];
}

export interface RepairProposal {
  readonly description: string;
  readonly filesToWrite: readonly PlannedFile[];
}

export interface RepairSource {
  proposeFixes(context: RepairContext): Promise<RepairProposal>;
}

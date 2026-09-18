/**
 * RepairDecisionSource: the deterministic adapter that turns ONE human-approved
 * RepairPlan into a Coding Agent run. It emits a plan decision built verbatim
 * from the validated plan, then read/create/update actions in plan order, then
 * a complete decision - nothing else. The Coding Agent owns revision
 * discipline (a file must be read or created by the run before an update),
 * forced confirmations, secret rejection, bounded iterations, cancellation,
 * and audit; this adapter holds no permissions and executes nothing itself.
 */

import type {
  CodingAction,
  CodingDecision,
  CodingDecisionContext,
  CodingDecisionSource,
  CodingPlan,
} from '@veltravia/coding-agent-core';
import type { RepairPlan } from '../types/index.js';

export interface RepairDecisionSourceOptions {
  readonly repairPlan: RepairPlan;
  readonly runLabel: string;
}

export class RepairDecisionSource implements CodingDecisionSource {
  private readonly repairPlan: RepairPlan;
  private readonly runLabel: string;
  private planned = false;
  private cursor = 0;
  private readPaths = new Set<string>();

  constructor(options: RepairDecisionSourceOptions) {
    this.repairPlan = options.repairPlan;
    this.runLabel = options.runLabel;
  }

  async nextDecision(_context: CodingDecisionContext): Promise<CodingDecision> {
    // 1. The plan (the Coding Agent pauses for HUMAN approval of exactly this
    //    plan; that approval IS the repair approval - no second mechanism).
    if (!this.planned) {
      this.planned = true;
      const plan: CodingPlan = {
        goal: `Apply the approved repair: ${this.repairPlan.diagnosis.summary}`,
        steps: this.repairPlan.changes.map((change): { readonly summary: string } => ({
          summary: `${change.mode === 'create' ? 'Create' : 'Update'} "${change.path}": ${change.reason}`,
        })),
        filesToInspect: this.repairPlan.changes
          .filter((change) => change.mode === 'update')
          .map((change) => change.path),
        filesToModify: this.repairPlan.changes.map((change) => change.path),
        validations: [],
        acceptanceCriteria: [this.repairPlan.verificationPlan],
      };
      return { type: 'plan', plan };
    }

    const changes = this.repairPlan.changes;

    // 2. Read every update-target first (pins the revision honestly; the
    //    coding manager enforces this anyway).
    const current = this.cursor < changes.length ? changes[this.cursor] : undefined;
    while (current !== undefined && current.mode === 'update') {
      if (!this.readPaths.has(current.path)) {
        this.readPaths.add(current.path);
        const readAction: CodingAction = { type: 'read_file', path: current.path };
        return { type: 'action', action: readAction };
      }
      // Already read (this run): fall through to the mutation below.
      const updateAction: CodingAction = {
        type: 'update_file',
        path: current.path,
        content: current.content,
      };
      this.cursor += 1;
      return { type: 'action', action: updateAction };
    }

    // 3. Apply the remaining change at the cursor (update or create).
    if (this.cursor < changes.length) {
      const change = changes[this.cursor];
      if (change !== undefined) {
        const action: CodingAction =
          change.mode === 'update'
            ? { type: 'update_file', path: change.path, content: change.content }
            : { type: 'create_file', path: change.path, content: change.content };
        this.cursor += 1;
        return { type: 'action', action };
      }
    }

    // 4. Done. The manager re-runs the tests itself (retesting phase).
    return {
      type: 'complete',
      summary: `${this.runLabel}: applied ${changes.length} repair change(s)`,
    };
  }
}

export function createRepairDecisionSource(
  options: RepairDecisionSourceOptions,
): CodingDecisionSource {
  return new RepairDecisionSource(options);
}

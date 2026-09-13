import type { PendingToolConfirmation } from '../state/index.js';

/**
 * Integration with the Step 5 confirmation model. The agent NEVER approves
 * its own confirmations and NEVER modifies a confirmation request: the
 * human decision flows through ToolManager.confirm() (the Step 5
 * authority), and this module only decides how the run resumes.
 */

/** The human decision as expressed at the agent boundary. */
export type HumanConfirmationDecision = 'approve' | 'reject';

/** How a decided confirmation resumes the run. */
export type ConfirmationResumePlan =
  | { readonly kind: 'execute' }
  | { readonly kind: 'continue_with_denial'; readonly message: string }
  | { readonly kind: 'undecided' };

/**
 * Maps the current state of the run's pending confirmation to a resume
 * plan. The confirmation must belong to the run's pending tool request;
 * anything else is rejected (no swapping, no replay).
 */
export function planConfirmationResume(
  pending: PendingToolConfirmation,
  confirmationState: 'required' | 'approved' | 'rejected' | 'expired',
): ConfirmationResumePlan {
  if (confirmationState === 'approved') {
    // Resume executes the SAME invocation with the SAME input - the Step 5
    // input-bound, single-use mechanism stays authoritative.
    return { kind: 'execute' };
  }
  if (confirmationState === 'rejected' || confirmationState === 'expired') {
    return {
      kind: 'continue_with_denial',
      message:
        confirmationState === 'rejected'
          ? 'The human operator rejected the confirmation for this tool request.'
          : 'The confirmation for this tool request expired before a decision was made.',
    };
  }
  return { kind: 'undecided' };
}

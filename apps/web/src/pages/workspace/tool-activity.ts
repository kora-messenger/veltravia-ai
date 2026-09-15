import type { AgentRunUiState } from './use-agent-run';
import type { ActivityEntryView } from './message-model';
import type { PendingConfirmationView, ToolResultView } from '../../api/agents';

/**
 * Tool + run activity mapping (Step 11C-3).
 *
 * Maps the run's SERVER-CONFIRMED tool activity into safe panel entries.
 * Nothing is invented: only recorded invocations and reported
 * confirmations become entries, in the backend's authoritative order.
 * Tool output is UNTRUSTED DATA - it is stringified into plain text and
 * bounded; the panel renders it as text, never as instructions.
 */

/** Maximum characters of untrusted tool output rendered in the panel. */
const MAX_OUTPUT_CHARS = 1600;

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

function riskLevel(value: string | null): RiskLevel | null {
  if (value === null) return null;
  return (RISK_LEVELS as readonly string[]).includes(value) ? (value as RiskLevel) : null;
}

/**
 * Renders untrusted tool output as bounded plain text. The output is
 * external data: it is never interpreted, only displayed, and always cut
 * with an honest note when it is too long to show.
 */
function formatUntrustedOutput(output: Record<string, unknown>): {
  text: string;
  truncated: boolean;
} {
  let text: string;
  try {
    text = JSON.stringify(output, null, 2) ?? '';
  } catch {
    return { text: 'The tool returned output that could not be displayed.', truncated: false };
  }
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated`, truncated: true };
}

/** Maps one recorded tool invocation to a safe activity entry. */
function toolResultEntry(result: ToolResultView): ActivityEntryView {
  const base = {
    id: `tool:${result.invocationId}`,
    label: `Ran ${result.toolId}`,
  };
  if (result.status === 'success') {
    const output = result.output === null ? null : formatUntrustedOutput(result.output);
    return {
      ...base,
      status: 'completed',
      confirmationRequired: false,
      detail: output === null ? undefined : output.text,
    };
  }
  const detailParts: string[] = [];
  if (result.error !== null) {
    detailParts.push(result.error.message);
  }
  return {
    ...base,
    status: result.status === 'denied' ? 'denied' : 'failed',
    confirmationRequired: result.status === 'denied',
    detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
  };
}

/** Maps the run's pending confirmation to a safe activity entry. */
function pendingConfirmationEntry(confirmation: PendingConfirmationView): ActivityEntryView {
  const risk = riskLevel(confirmation.riskLevel);
  const status =
    confirmation.state === 'expired'
      ? 'expired'
      : confirmation.state === 'rejected'
        ? 'denied'
        : confirmation.state === 'approved'
          ? 'completed'
          : 'awaiting-confirmation';
  return {
    id: `confirmation:${confirmation.confirmationId}`,
    label: `${confirmation.toolId} needs your approval`,
    status,
    riskLevel: risk === null ? undefined : risk,
    confirmationRequired: true,
    detail:
      confirmation.state === 'expired'
        ? 'This request expired before a decision was made.'
        : 'The run is paused. It resumes only after your decision.',
  };
}

/**
 * Builds the tool section entries for the activity panel: recorded tool
 * invocations in the backend's order, followed by the pending
 * confirmation when the server reports one.
 */
export function toolActivityEntries(
  toolResults: readonly ToolResultView[],
  pendingConfirmation: PendingConfirmationView | null,
): readonly ActivityEntryView[] {
  const entries = toolResults.map(toolResultEntry);
  if (pendingConfirmation !== null) {
    entries.push(pendingConfirmationEntry(pendingConfirmation));
  }
  return entries;
}

/**
 * Builds the run section entries for the activity panel from the run's
 * UI state. Honest by construction: every phase maps to one entry and
 * no progress is invented (a paused run is paused, a failed run failed).
 */
export function runActivityEntries(state: AgentRunUiState): readonly ActivityEntryView[] {
  switch (state.phase) {
    case 'idle':
      return [];
    case 'creating':
      return [{ id: 'run:start', label: 'Starting the run', status: 'queued' }];
    case 'running':
      return [{ id: 'run:work', label: 'Working on your request', status: 'running' }];
    case 'paused':
      return [
        { id: 'run:pause', label: 'Waiting for your decision', status: 'awaiting-confirmation' },
      ];
    case 'completed':
      return [{ id: 'run:done', label: 'Run finished', status: 'completed' }];
    case 'failed':
      return [{ id: 'run:failed', label: 'Run failed', status: 'failed' }];
    case 'cancelled':
      return [{ id: 'run:cancelled', label: 'Run cancelled', status: 'cancelled' }];
    case 'limit-reached':
      return [
        {
          id: 'run:limit',
          label: 'Run stopped at a safety limit',
          status: 'cancelled',
          detail: state.failureMessage ?? undefined,
        },
      ];
    case 'error':
      return [{ id: 'run:error', label: 'Lost contact with the run', status: 'failed' }];
  }
}

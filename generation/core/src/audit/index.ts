/**
 * Generation audit events: bounded metadata only - run ids, states, phases,
 * and tool ids. Values (file contents, command output, user ideas) are
 * never audited, and secrets can never appear here by construction.
 */

export const GENERATION_AUDIT_EVENT_TYPES = [
  'generation_run_created',
  'generation_plan_ready',
  'generation_plan_approved',
  'generation_plan_rejected',
  'generation_phase_started',
  'generation_phase_completed',
  'generation_repair_attempted',
  'generation_run_completed',
  'generation_run_failed',
  'generation_run_cancelled',
  'generation_confirmation_requested',
  'generation_tool_executed',
  'generation_tool_denied',
] as const;

export type GenerationAuditEventType = (typeof GENERATION_AUDIT_EVENT_TYPES)[number];

export interface GenerationAuditEvent {
  readonly type: GenerationAuditEventType;
  readonly runId: string;
  readonly at: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type GenerationAuditSink = (event: GenerationAuditEvent) => void;

/**
 * Builds an audit emitter factory bound to a sink. An absent sink means
 * events are dropped - auditing is a side channel, never a control flow.
 */
export function bindGenerationAudit(
  sink: GenerationAuditSink | undefined,
  now: () => Date,
): (runId: string) => (type: GenerationAuditEventType, details?: Record<string, unknown>) => void {
  return (runId: string) => {
    return (type, details = {}) => {
      if (sink === undefined) return;
      sink({
        type,
        runId,
        at: now().toISOString(),
        details,
      });
    };
  };
}

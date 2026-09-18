/**
 * Bounded audit events for the Testing & Debugging Agent. Events carry phase
 * names, tool ids, and outcome codes - never file content, never raw command
 * output, never credentials.
 */

export const TEST_AUDIT_EVENT_TYPES = [
  'testing_run_started',
  'testing_plan_created',
  'testing_plan_approved',
  'testing_plan_rejected',
  'testing_confirmation_requested',
  'testing_confirmation_resumed',
  'testing_command_executed',
  'testing_test_pass_result',
  'testing_analysis_started',
  'testing_diagnosis_created',
  'testing_repair_proposed',
  'testing_repair_approved',
  'testing_repair_rejected',
  'testing_repair_applied',
  'testing_repair_failed',
  'testing_retest_started',
  'testing_revision_conflict',
  'testing_run_completed',
  'testing_run_failed',
  'testing_run_cancelled',
] as const;

export type TestAuditEventType = (typeof TEST_AUDIT_EVENT_TYPES)[number];

export interface TestAuditEvent {
  readonly type: TestAuditEventType;
  readonly runId: string;
  readonly at: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type TestAuditSink = (event: TestAuditEvent) => void;

/** Binds a sink with the run id and a clock; drops nothing, adds nothing. */
export function bindTestAudit(
  runId: string,
  now: () => Date,
  sink: TestAuditSink | undefined,
): (type: TestAuditEventType, data: Record<string, unknown>) => void {
  if (sink === undefined) {
    return () => undefined;
  }
  return (type, data) => {
    sink({ type, runId, at: now().toISOString(), data });
  };
}

import type {
  AppTestReport,
  AppTestStatus,
  Bug,
  BugSeverity,
  PendingApproval,
  RunStatus,
  TestRunState,
} from '../../api/app-testing';

/**
 * What the testing page says, decided in one place.
 *
 * Kept out of the components so the wording rules can be tested directly. The
 * page may only say what the report and run status say: nothing here upgrades a
 * result, and "tested" is never shown unless the report says it was fully tested.
 */

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'primary';

const STATUS_LABEL: Readonly<Record<AppTestStatus, string>> = {
  PASSED: 'Passed',
  FAILED: 'Failed',
  PARTIALLY_PASSED: 'Partially passed',
  CANCELLED: 'Cancelled',
  BLOCKED: 'Blocked',
};

const STATUS_TONE: Readonly<Record<AppTestStatus, Tone>> = {
  PASSED: 'success',
  FAILED: 'error',
  PARTIALLY_PASSED: 'warning',
  CANCELLED: 'neutral',
  BLOCKED: 'warning',
};

export function statusLabel(status: AppTestStatus): string {
  return STATUS_LABEL[status];
}

export function statusTone(status: AppTestStatus): Tone {
  return STATUS_TONE[status];
}

/** True while the run can still change, so the page should keep checking. */
export function isActive(state: TestRunState): boolean {
  return (
    state === 'created' ||
    state === 'planning' ||
    state === 'approved' ||
    state === 'running' ||
    state === 'analyzing' ||
    state === 'repairing' ||
    state === 'retesting'
  );
}

/** True once nothing more will happen to the run. */
export function isFinished(state: TestRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

const STATE_LABEL: Readonly<Record<TestRunState, string>> = {
  created: 'Starting',
  planning: 'Planning the tests',
  awaiting_approval: 'Waiting for your approval',
  approved: 'Approved, starting',
  running: 'Running tests',
  analyzing: 'Analysing a failure',
  awaiting_repair_approval: 'Waiting for your approval of a repair',
  repairing: 'Applying the approved repair',
  retesting: 'Re-running tests after the repair',
  completed: 'Finished',
  failed: 'Stopped with an error',
  cancelled: 'Cancelled',
};

export function stateLabel(state: TestRunState): string {
  return STATE_LABEL[state];
}

/** What the person is being asked to approve, in plain words. */
export function approvalCopy(pending: PendingApproval | null): {
  readonly title: string;
  readonly detail: string;
} | null {
  if (pending === null) return null;
  switch (pending.kind) {
    case 'plan_approval':
      return {
        title: 'Approve the test plan',
        detail:
          'The plan lists the commands that would run in the sandbox. Nothing runs until you approve it.',
      };
    case 'tool_confirmation':
      return {
        title: 'Approve running a command',
        detail: 'A command is about to run in the sandbox. It runs only if you approve.',
      };
    case 'repair_approval':
      return {
        title: 'Approve a proposed repair',
        detail:
          'A change to your code is proposed. It is applied only if you approve, and the tests run again afterwards.',
      };
    default:
      return {
        title: 'Your decision is needed',
        detail: 'The run is waiting for you before it can go on.',
      };
  }
}

/** The honest one-line statement about what ran the tests. */
export function environmentCopy(report: AppTestReport): string {
  const { runtimeId, osIsolation, executedRealCode } = report.environment;
  if (!executedRealCode) {
    return `Ran on the "${runtimeId}" runtime, which does not execute real code. Results show how the run behaved, not how your app behaves.${
      osIsolation ? '' : ' It also has no OS-level isolation.'
    }`;
  }
  return `Ran on the "${runtimeId}" runtime${osIsolation ? ' with OS-level isolation' : ''}.`;
}

/** The headline sentence for a finished report. Never says more than the status. */
export function headline(report: AppTestReport): string {
  if (report.fullyTested) {
    return `All ${report.executed} tests passed.`;
  }
  return report.statusReason;
}

const SEVERITY_ORDER: readonly BugSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function severityTone(severity: BugSeverity): Tone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function severityRank(severity: BugSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** "Confirmed" means a test failed. "Suspected" means static analysis only. */
export function certaintyLabel(bug: Pick<Bug, 'certainty'>): string {
  return bug.certainty === 'confirmed' ? 'Confirmed by a failing test' : 'Suspected, not confirmed';
}

export interface Counts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly executed: number;
}

export function countsOf(report: AppTestReport): Counts {
  return {
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    executed: report.executed,
  };
}

/** What the primary action should be for the current state. */
export type PrimaryAction = 'start' | 'cancel' | 'rerun' | 'none';

export function primaryAction(status: RunStatus | null): PrimaryAction {
  if (status === null) return 'start';
  if (isFinished(status.state)) return 'rerun';
  if (status.pendingApproval !== null) return 'none';
  return 'cancel';
}

/** The run can be cancelled while it is not finished. */
export function canCancel(status: RunStatus | null): boolean {
  return status !== null && !isFinished(status.state);
}

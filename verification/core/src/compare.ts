/**
 * Failure diagnosis and run comparison - Step 45.
 *
 * Diagnosis prepares what an authorised agent needs to fix a failure: which
 * operation failed, what the runner said, and which project files it named.
 * Comparison answers the only question that matters after a repair attempt:
 * is this failure gone, and did anything new break?
 */

import { scrubSecrets } from './sanitize.js';
import type { OperationResult, VerificationOperation, VerificationRunRecord } from './types.js';

export interface FailureDiagnosis {
  readonly operation: VerificationOperation;
  readonly commandId: string;
  readonly status: OperationResult['status'];
  readonly summary: string | null;
  /** Project files the output named, bounded and de-duplicated. */
  readonly files: readonly string[];
  /** Bounded, scrubbed excerpt for the agent. */
  readonly excerpt: string;
}

export interface DiagnosisBundle {
  readonly runId: string;
  readonly projectId: string;
  readonly revision: string | null;
  readonly attempt: number;
  readonly failures: readonly FailureDiagnosis[];
  /** True when the run had failures an agent could work on. */
  readonly repairable: boolean;
  /** Plain instruction text for the agent, already sanitised. */
  readonly brief: string;
}

const FILE_HINT =
  /(?:^|[\s('"])((?:[\w.@-]+\/){0,6}[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|py|go|rs|java|rb|php|vue|svelte|sql|yml|yaml))(?::\d+){0,2}/g;

function fileHints(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FILE_HINT)) {
    const path = match[1];
    if (path === undefined) continue;
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) continue;
    found.add(path);
    if (found.size >= 12) break;
  }
  return [...found];
}

export function buildDiagnosis(record: VerificationRunRecord): DiagnosisBundle {
  const failures: FailureDiagnosis[] = [];
  for (const result of record.results) {
    if (result.status !== 'failed' && result.status !== 'timed_out') continue;
    const excerpt = scrubSecrets(result.outputTail.slice(-1_500)).text;
    failures.push({
      operation: result.operation,
      commandId: result.commandId,
      status: result.status,
      summary: result.errorSummary === null ? null : scrubSecrets(result.errorSummary).text,
      files: fileHints(`${result.errorSummary ?? ''}\n${result.outputTail}`),
      excerpt,
    });
  }

  const lines: string[] = [
    `Verification run ${record.id} for project ${record.projectId}` +
      (record.revision === null ? ' (no pinned revision)' : ` at revision ${record.revision}`) +
      ` reported ${record.status}.`,
  ];
  if (record.blocked.length > 0) {
    lines.push(
      'Operations that did not run: ' +
        record.blocked.map((b) => `${b.operation} (${b.reason})`).join(', '),
    );
  }
  for (const failure of failures) {
    lines.push(
      `- ${failure.operation} ${failure.status}: ${failure.summary ?? 'no summary line was printed'}`,
    );
    if (failure.files.length > 0) lines.push(`  files: ${failure.files.slice(0, 8).join(', ')}`);
  }
  if (failures.length === 0)
    lines.push('No failing command was recorded, so there is nothing to repair.');

  return {
    runId: record.id,
    projectId: record.projectId,
    revision: record.revision,
    attempt: record.attempt,
    failures,
    repairable: failures.length > 0,
    brief: scrubSecrets(lines.join('\n')).text,
  };
}

export interface ComparisonResult {
  readonly previousRunId: string;
  readonly currentRunId: string;
  readonly resolved: readonly VerificationOperation[];
  readonly stillFailing: readonly VerificationOperation[];
  readonly regressed: readonly VerificationOperation[];
  readonly notRun: readonly VerificationOperation[];
  readonly improved: boolean;
  readonly summary: string;
}

function statusOf(
  record: VerificationRunRecord,
  operation: VerificationOperation,
): OperationResult['status'] | 'absent' {
  return record.results.find((result) => result.operation === operation)?.status ?? 'absent';
}

function isFailure(status: OperationResult['status'] | 'absent'): boolean {
  return status === 'failed' || status === 'timed_out';
}

/** Compares two runs operation by operation. A pass never hides a new failure. */
export function compareRuns(
  previous: VerificationRunRecord,
  current: VerificationRunRecord,
): ComparisonResult {
  const operations = new Set<VerificationOperation>([
    ...previous.results.map((result) => result.operation),
    ...current.results.map((result) => result.operation),
  ]);
  const resolved: VerificationOperation[] = [];
  const stillFailing: VerificationOperation[] = [];
  const regressed: VerificationOperation[] = [];
  const notRun: VerificationOperation[] = [];

  for (const operation of operations) {
    const before = statusOf(previous, operation);
    const after = statusOf(current, operation);
    if (isFailure(before) && after === 'passed') {
      resolved.push(operation);
      continue;
    }
    if (isFailure(before) && isFailure(after)) {
      stillFailing.push(operation);
      continue;
    }
    if (before === 'passed' && isFailure(after)) {
      regressed.push(operation);
      continue;
    }
    if (
      after === 'absent' ||
      after === 'blocked' ||
      after === 'cancelled' ||
      after === 'incomplete'
    ) {
      notRun.push(operation);
    }
  }

  const improved = resolved.length > 0 && regressed.length === 0;
  const summary =
    resolved.length === 0 && stillFailing.length === 0 && regressed.length === 0
      ? 'Neither run recorded a comparable failure.'
      : `resolved ${resolved.length}, still failing ${stillFailing.length}, regressed ${regressed.length}` +
        (notRun.length > 0 ? `, not run ${notRun.length}` : '');

  return {
    previousRunId: previous.id,
    currentRunId: current.id,
    resolved,
    stillFailing,
    regressed,
    notRun,
    improved,
    summary,
  };
}

/** How many repair attempts remain, given the run chain. */
export function repairBudget(record: VerificationRunRecord): {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly reason: string;
} {
  const remaining = Math.max(0, record.limits.maxRepairAttempts - record.attempt);
  if (record.status !== 'failed' && record.status !== 'timed_out') {
    return { allowed: false, remaining, reason: 'Only a failing run can be repaired.' };
  }
  if (remaining === 0) {
    return {
      allowed: false,
      remaining,
      reason: `This run already used its ${record.limits.maxRepairAttempts} repair attempts.`,
    };
  }
  return { allowed: true, remaining, reason: 'A repair attempt is available.' };
}

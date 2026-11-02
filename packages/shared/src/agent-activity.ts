/**
 * The normalised agent-activity contract.
 *
 * One shape for every engine. Before this, each surface read whichever run shape
 * its route happened to return, so a step could arrive with `stepId` where the
 * other end expected `id`. The browser must never have to know which engine
 * produced a row, so an activity is defined here once, validated here once, and
 * both ends reuse this file:
 *
 * - the API derives activities from the run it already owns, validates them and
 *   streams them;
 * - the page validates what arrives and drops anything malformed, so a server
 *   ahead of or behind this build cannot corrupt the timeline.
 *
 * Everything in an activity is safe by construction: the titles are written by
 * the platform, and the two text blocks are scrubbed and bounded before they are
 * put in the event. No field here can carry a credential, a raw provider
 * response, or hidden reasoning.
 */

import { failure, success, type Result } from './index.js';

export const ACTIVITY_CATEGORIES = [
  'thinking',
  'planning',
  'searching',
  'reading',
  'writing',
  'editing',
  'creating_files',
  'deleting_files',
  'checking_dependencies',
  'installing_dependencies',
  'running_tests',
  'linting',
  'building',
  'validating',
  'executing_tool',
  'awaiting_approval',
  'retrying',
  'completed',
  'failed',
  'cancelled',
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/**
 * `pending` is known but not started, `running` is under way, and the rest are
 * terminal. `awaiting_approval` is deliberately not terminal: the work resumes
 * once a person decides.
 */
export const ACTIVITY_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** Statuses a row never leaves, so a late event cannot reopen finished work. */
export const TERMINAL_ACTIVITY_STATUSES: readonly ActivityStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export interface ActivityErrorView {
  readonly code: string;
  readonly message: string;
}

export interface AgentActivityEvent {
  /** Stable per event, so a replayed event is recognisable. */
  readonly eventId: string;
  readonly runId: string;
  /** Position in the run's own order. Gaps mean missed events, not lost work. */
  readonly sequence: number;
  readonly activityId: string;
  /** Set when this row belongs to a group; the group carries the parent id. */
  readonly parentActivityId: string | null;
  readonly category: ActivityCategory;
  /** Written by the platform in ordinary words: "Read package.json". */
  readonly title: string;
  readonly status: ActivityStatus;
  readonly safeSummary: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly safeInput: string | null;
  readonly safeOutput: string | null;
  readonly error: ActivityErrorView | null;
  readonly retryCount: number;
}

export const FINAL_REPORT_STATUSES = [
  'completed',
  'completed_with_warnings',
  'partially_completed',
  'failed',
  'cancelled',
] as const;

export type FinalReportStatus = (typeof FINAL_REPORT_STATUSES)[number];

export interface FileChangeSet {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
}

/** What a validation step actually reported, or null when it never ran. */
export type ValidationOutcome = 'passed' | 'failed' | 'not_run';

export interface ValidationReport {
  readonly tests: ValidationOutcome;
  readonly lint: ValidationOutcome;
  readonly types: ValidationOutcome;
  readonly build: ValidationOutcome;
}

export interface FinalAgentReport {
  readonly status: FinalReportStatus;
  readonly summary: string;
  readonly completed: readonly string[];
  readonly filesChanged: FileChangeSet;
  readonly validation: ValidationReport;
  readonly failures: readonly { readonly title: string; readonly reason: string }[];
  readonly recovery: readonly string[];
  readonly remaining: readonly string[];
}

/** Everything a reconnecting client needs to render the truth, in one reply. */
export interface AgentActivitySnapshot {
  readonly runId: string;
  /** Highest sequence included, so a stream can resume after it. */
  readonly sequence: number;
  readonly runStatus: string;
  readonly terminal: boolean;
  readonly activities: readonly AgentActivityEvent[];
  readonly report: FinalAgentReport | null;
}

const CATEGORY_SET = new Set<string>(ACTIVITY_CATEGORIES);
const STATUS_SET = new Set<string>(ACTIVITY_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Validates one activity as it leaves (or enters) the wire.
 *
 * Unknown keys are ignored rather than rejected: a newer server adding a field
 * must not stop an older page from drawing the row. A missing or mistyped
 * required field is a refusal, because drawing it would mean inventing it.
 */
export function parseAgentActivityEvent(value: unknown): Result<AgentActivityEvent, string> {
  if (!isRecord(value)) return failure('An activity must be an object.');
  const eventId = text(value.eventId);
  const runId = text(value.runId);
  const activityId = text(value.activityId);
  const title = text(value.title);
  const safeSummary = text(value.safeSummary);
  const startedAt = text(value.startedAt);
  if (!eventId) return failure('An activity needs an eventId.');
  if (!runId) return failure('An activity needs a runId.');
  if (!activityId) return failure('An activity needs an activityId.');
  if (!title) return failure('An activity needs a title.');
  if (safeSummary === null) return failure('An activity needs a safeSummary.');
  if (!startedAt) return failure('An activity needs a startedAt.');

  const category = text(value.category) ?? '';
  if (!CATEGORY_SET.has(category)) return failure(`Unknown activity category "${category}".`);
  const status = text(value.status) ?? '';
  if (!STATUS_SET.has(status)) return failure(`Unknown activity status "${status}".`);

  const sequence = value.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    return failure('An activity needs an integer sequence of at least 1.');
  }
  const durationMs = value.durationMs;
  if (durationMs !== null && (typeof durationMs !== 'number' || !Number.isFinite(durationMs))) {
    return failure('durationMs must be a number or null.');
  }
  const retryCount = value.retryCount;
  if (retryCount !== undefined && (typeof retryCount !== 'number' || retryCount < 0)) {
    return failure('retryCount must be a non-negative number.');
  }
  const parentActivityId = value.parentActivityId;
  if (parentActivityId !== null && typeof parentActivityId !== 'string') {
    return failure('parentActivityId must be a string or null.');
  }
  const error = value.error;
  if (error !== null && error !== undefined) {
    if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      return failure('error must be {code, message} or null.');
    }
  }

  return success({
    eventId,
    runId,
    sequence,
    activityId,
    parentActivityId: typeof parentActivityId === 'string' ? parentActivityId : null,
    category: category as ActivityCategory,
    title,
    status: status as ActivityStatus,
    safeSummary,
    startedAt,
    completedAt: text(value.completedAt),
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    safeInput: text(value.safeInput),
    safeOutput: text(value.safeOutput),
    error: isRecord(error) ? { code: String(error.code), message: String(error.message) } : null,
    retryCount: typeof retryCount === 'number' ? retryCount : 0,
  });
}

export function parseAgentActivitySnapshot(value: unknown): Result<AgentActivitySnapshot, string> {
  if (!isRecord(value)) return failure('A snapshot must be an object.');
  const runId = text(value.runId);
  const runStatus = text(value.runStatus);
  if (!runId) return failure('A snapshot needs a runId.');
  if (!runStatus) return failure('A snapshot needs a runStatus.');
  if (typeof value.terminal !== 'boolean') return failure('A snapshot needs a terminal flag.');
  const rawActivities = value.activities;
  if (!Array.isArray(rawActivities)) return failure('A snapshot needs an activities array.');
  const activities: AgentActivityEvent[] = [];
  for (const raw of rawActivities) {
    const parsed = parseAgentActivityEvent(raw);
    if (!parsed.ok) return failure(parsed.error);
    activities.push(parsed.value);
  }
  const sequence = value.sequence;
  if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
    return failure('A snapshot needs a numeric sequence.');
  }
  return success({
    runId,
    sequence,
    runStatus,
    terminal: value.terminal,
    activities,
    report: parseFinalReport(value.report),
  });
}

export function parseFinalReport(value: unknown): FinalAgentReport | null {
  if (!isRecord(value)) return null;
  const status = text(value.status) ?? '';
  if (!FINAL_REPORT_STATUSES.includes(status as FinalReportStatus)) return null;
  const summary = text(value.summary);
  if (summary === null) return null;
  const strings = (input: unknown): readonly string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  const files = isRecord(value.filesChanged) ? value.filesChanged : {};
  const validation = isRecord(value.validation) ? value.validation : {};
  const outcome = (input: unknown): ValidationOutcome =>
    input === 'passed' || input === 'failed' ? input : 'not_run';
  const failures = Array.isArray(value.failures)
    ? value.failures
        .filter(
          (item): item is { title: string; reason: string } =>
            isRecord(item) && typeof item.title === 'string' && typeof item.reason === 'string',
        )
        .map((item) => ({ title: item.title, reason: item.reason }))
    : [];
  return {
    status: status as FinalReportStatus,
    summary,
    completed: strings(value.completed),
    filesChanged: {
      created: strings(files.created),
      updated: strings(files.updated),
      deleted: strings(files.deleted),
    },
    validation: {
      tests: outcome(validation.tests),
      lint: outcome(validation.lint),
      types: outcome(validation.types),
      build: outcome(validation.build),
    },
    failures,
    recovery: strings(value.recovery),
    remaining: strings(value.remaining),
  };
}

/**
 * Merges a batch of activities into the list the page holds.
 *
 * Order comes from `sequence`, never from arrival: a replayed event after a
 * reconnect must not move a row. When the same activity arrives twice, the
 * higher sequence wins, and a terminal status is never reopened by a stale
 * `running` event. That is what stops a reconnect from duplicating or unwinding
 * work the server has already finished.
 */
export function mergeAgentActivities(
  current: readonly AgentActivityEvent[],
  incoming: readonly AgentActivityEvent[],
): AgentActivityEvent[] {
  const byId = new Map<string, AgentActivityEvent>();
  for (const activity of current) byId.set(activity.activityId, activity);
  for (const activity of incoming) {
    const existing = byId.get(activity.activityId);
    if (existing === undefined) {
      byId.set(activity.activityId, activity);
      continue;
    }
    if (activity.sequence < existing.sequence) continue;
    if (
      TERMINAL_ACTIVITY_STATUSES.includes(existing.status) &&
      !TERMINAL_ACTIVITY_STATUSES.includes(activity.status)
    ) {
      continue;
    }
    byId.set(activity.activityId, activity);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

/** True when the whole run has stopped producing activity. */
export function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'limit_reached'
  );
}

/**
 * Turns a run the engine already owns into the normalised activity timeline.
 *
 * The page used to work out what a run was doing from whatever fields each route
 * returned. That is how a step arrived with `stepId` while the other end read
 * `id`, and it is why every surface had its own idea of a status name. The
 * mapping now happens once, here, from the engine's own steps:
 *
 * - a step becomes an activity, with a category derived from the tool it ran and
 *   a title written in ordinary words ("Read package.json", "Ran tests");
 * - consecutive file changes become a group, so eight writes read as one line
 *   that opens rather than eight lines that bury the rest;
 * - the `Command` and `Output` blocks are the scrubbed, bounded renderings from
 *   `step-view`, never the raw records a tool was handed.
 *
 * Nothing here is scheduled and nothing is timed: an activity exists because a
 * step exists. A run that has published no steps has exactly one `thinking`
 * row, which is true of it, rather than a scripted sequence of things it might
 * do next.
 */

import {
  ACTIVITY_STATUSES,
  isTerminalRunStatus,
  type AgentActivitySnapshot,
  type ActivityCategory,
  type ActivityStatus,
  type AgentActivityEvent,
} from '@veltravia/shared';
import type { ReasoningRun, ReasoningToolStep } from './engine.js';
import { buildFinalReport } from './report.js';
import { scrubReasoningText } from './errors.js';
import { MAX_COMMAND_CHARS, MAX_OUTPUT_CHARS } from './step-view.js';

/** A title is one short line; past this it stops being scannable. */
const MAX_TITLE_CHARS = 72;
/** Groups need enough members to earn the extra tap. */
const MIN_GROUP_SIZE = 2;

interface ToolDescription {
  readonly category: ActivityCategory;
  /** The verb the row starts with, in the past tense: "Read". */
  readonly verb: string;
  /** What it acted on, from the arguments; null when there is nothing to name. */
  readonly object: string | null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found !== null) return found;
    }
  }
  return null;
}

function commandText(input: Readonly<Record<string, unknown>> | undefined): string {
  if (input === undefined) return '';
  return (firstString(input.command) ?? firstString(input.args) ?? firstString(input.script) ?? '')
    .toLowerCase()
    .slice(0, 400);
}

function pathOf(input: Readonly<Record<string, unknown>> | undefined): string | null {
  if (input === undefined) return null;
  for (const key of ['path', 'filePath', 'file', 'source', 'name', 'target']) {
    const value = firstString(input[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Tool id to the words a person would use for what it did. */
export function describeTool(
  toolId: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ToolDescription {
  const path = pathOf(input);
  if (toolId.endsWith('sandbox.execute')) {
    const command = commandText(input);
    if (/vitest|jest|\btest\b|npm (run )?test/.test(command)) {
      return { category: 'running_tests', verb: 'Ran', object: 'the tests' };
    }
    if (/eslint|prettier|\blint\b/.test(command)) {
      return { category: 'linting', verb: 'Linted', object: 'the code' };
    }
    if (/\btsc\b|typecheck|type-check/.test(command)) {
      return { category: 'validating', verb: 'Checked', object: 'the types' };
    }
    if (/npm (run )?build|vite build|\bbuild\b/.test(command)) {
      return { category: 'building', verb: 'Built', object: 'the app' };
    }
    if (/npm (install|i|ci)|yarn add|pnpm add|\binstall\b/.test(command)) {
      return {
        category: 'installing_dependencies',
        verb: 'Installed',
        object: 'dependencies',
      };
    }
    return { category: 'executing_tool', verb: 'Ran', object: 'a command' };
  }
  if (toolId.endsWith('sandbox.create')) {
    return { category: 'executing_tool', verb: 'Started', object: 'a sandbox' };
  }
  if (toolId.endsWith('read-file') || toolId.endsWith('.read')) {
    return { category: 'reading', verb: 'Read', object: path };
  }
  if (toolId.endsWith('list-files') || toolId.endsWith('.list')) {
    return { category: 'searching', verb: 'Listed', object: path ?? 'the files' };
  }
  if (toolId.endsWith('inspect')) {
    return { category: 'searching', verb: 'Inspected', object: path ?? 'the project' };
  }
  if (toolId.endsWith('create-file')) {
    return { category: 'creating_files', verb: 'Created', object: path };
  }
  if (toolId.endsWith('update-file')) {
    return { category: 'editing', verb: 'Updated', object: path };
  }
  if (toolId.endsWith('delete-file')) {
    return { category: 'deleting_files', verb: 'Deleted', object: path };
  }
  if (toolId.endsWith('move-file')) {
    return { category: 'editing', verb: 'Moved', object: path };
  }
  if (toolId.includes('dependencies')) {
    return { category: 'checking_dependencies', verb: 'Checked', object: 'dependencies' };
  }
  if (toolId.startsWith('codebase.') || toolId.includes('search')) {
    return { category: 'searching', verb: 'Searched', object: path ?? 'the project' };
  }
  if (toolId.startsWith('files.') || toolId.startsWith('document.')) {
    return { category: 'reading', verb: 'Read', object: path ?? 'a file' };
  }
  if (
    toolId.startsWith('github.') ||
    toolId.startsWith('connector.') ||
    toolId.startsWith('integration.')
  ) {
    return { category: 'executing_tool', verb: 'Used', object: null };
  }
  return { category: 'executing_tool', verb: 'Ran', object: null };
}

const STEP_STATUS: Record<ReasoningToolStep['status'], ActivityStatus> = {
  success: 'succeeded',
  failure: 'failed',
  denied: 'cancelled',
  awaiting_confirmation: 'awaiting_approval',
};

function trim(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function renderValue(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const scrubbed = scrubReasoningText(raw).trim();
  if (scrubbed === '') return null;
  return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max)}…`;
}

function titleFor(description: ToolDescription): string {
  const base =
    description.object === null
      ? `${description.verb}`
      : `${description.verb} ${description.object}`;
  return trim(base, MAX_TITLE_CHARS);
}

function durationOf(step: ReasoningToolStep): number | null {
  const start = Date.parse(step.requestedAt);
  const end = Date.parse(step.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function summaryFor(
  step: ReasoningToolStep,
  status: ActivityStatus,
  description: ToolDescription,
  title: string,
): string {
  if (status === 'awaiting_approval') return `${title} is waiting for your approval.`;
  if (status === 'cancelled') return `${title} was declined, so it did not run.`;
  if (status === 'failed') {
    const reason = step.error?.message ?? 'the tool reported a failure';
    return `${title} failed: ${trim(scrubReasoningText(reason), 160)}`;
  }
  if (description.category === 'running_tests') return `${title}, and they passed.`;
  return `${title}.`;
}

interface Draft {
  readonly kind: 'step' | 'group';
  readonly activityId: string;
  readonly parentActivityId: string | null;
  readonly category: ActivityCategory;
  readonly title: string;
  readonly status: ActivityStatus;
  readonly safeSummary: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly safeInput: string | null;
  readonly safeOutput: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly retryCount: number;
  readonly groupId: string | null;
}

const FILE_CATEGORIES: readonly ActivityCategory[] = [
  'creating_files',
  'editing',
  'deleting_files',
];

/**
 * The run, as the rows the timeline draws.
 *
 * Sequence numbers come from position, so the same run always produces the same
 * list. That is what makes a reconnect safe: the client asks for everything
 * after the last sequence it holds and cannot end up with a row twice.
 */
export function deriveRunActivities(run: ReasoningRun): AgentActivityEvent[] {
  const drafts: Draft[] = [];

  if (run.steps.length === 0) {
    const running = run.status === 'running';
    drafts.push({
      kind: 'step',
      activityId: `${run.id}:thinking`,
      parentActivityId: null,
      category: 'thinking',
      title: run.plan === undefined ? 'Thinking' : 'Planned the work',
      status: running ? 'running' : run.status === 'cancelled' ? 'cancelled' : 'succeeded',
      safeSummary:
        run.plan === undefined
          ? 'Working out what this request needs.'
          : trim(scrubReasoningText(run.plan.goal), 160),
      startedAt: run.createdAt,
      completedAt: running ? null : run.updatedAt,
      durationMs: running ? null : elapsed(run.createdAt, run.updatedAt),
      safeInput: null,
      safeOutput: null,
      error: null,
      retryCount: 0,
      groupId: null,
    });
    return finalise(run, drafts);
  }

  if (run.plan !== undefined) {
    drafts.push({
      kind: 'step',
      activityId: `${run.id}:plan`,
      parentActivityId: null,
      category: 'planning',
      title: 'Planned the work',
      status: 'succeeded',
      safeSummary: trim(scrubReasoningText(run.plan.goal), 160),
      startedAt: run.createdAt,
      completedAt: run.steps[0]?.requestedAt ?? run.createdAt,
      durationMs: null,
      safeInput: null,
      safeOutput: null,
      error: null,
      retryCount: 0,
      groupId: null,
    });
  }

  let index = 0;
  while (index < run.steps.length) {
    const step = run.steps[index];
    if (step === undefined) break;
    const description = describeTool(step.toolId, step.input);
    if (!FILE_CATEGORIES.includes(description.category)) {
      drafts.push(stepDraft(step, description, null));
      index += 1;
      continue;
    }
    // Collect the consecutive run of file changes so they can be one group.
    const start = index;
    while (index < run.steps.length) {
      const candidate = run.steps[index];
      if (candidate === undefined) break;
      if (!FILE_CATEGORIES.includes(describeTool(candidate.toolId, candidate.input).category))
        break;
      index += 1;
    }
    const members = run.steps.slice(start, index);
    if (members.length < MIN_GROUP_SIZE) {
      drafts.push(stepDraft(step, description, null));
      continue;
    }
    const groupId = `${run.id}:group-write-${start}`;
    const statuses = members.map((member) => STEP_STATUS[member.status]);
    const first = members[0];
    const last = members[members.length - 1];
    drafts.push({
      kind: 'group',
      activityId: groupId,
      parentActivityId: null,
      category: 'writing',
      title: groupTitle(statuses),
      // A group is only as finished as its slowest member, and a failed member
      // is never hidden behind a tick.
      status: groupStatus(statuses),
      safeSummary: `${members.length} file changes.`,
      startedAt: first?.requestedAt ?? run.createdAt,
      completedAt: last?.completedAt ?? null,
      durationMs:
        first === undefined || last === undefined
          ? null
          : elapsed(first.requestedAt, last.completedAt),
      safeInput: null,
      safeOutput: null,
      error: null,
      retryCount: 0,
      groupId,
    });
    for (const member of members) {
      drafts.push(stepDraft(member, describeTool(member.toolId, member.input), groupId));
    }
  }

  return finalise(run, drafts);
}

function stepDraft(
  step: ReasoningToolStep,
  description: ToolDescription,
  groupId: string | null,
): Draft {
  const status = STEP_STATUS[step.status];
  const title = titleFor(description);
  return {
    kind: 'step',
    activityId: `${step.stepId}`,
    parentActivityId: groupId,
    category: description.category,
    title,
    status,
    safeSummary: summaryFor(step, status, description, title),
    startedAt: step.requestedAt,
    completedAt: status === 'awaiting_approval' ? null : step.completedAt,
    durationMs: status === 'awaiting_approval' ? null : durationOf(step),
    safeInput: renderValue(step.input, MAX_COMMAND_CHARS),
    safeOutput:
      renderValue(step.output, MAX_OUTPUT_CHARS) ??
      (step.error === undefined
        ? null
        : renderValue({ error: step.error.code, message: step.error.message }, MAX_OUTPUT_CHARS)),
    error:
      step.error === undefined
        ? null
        : {
            code: step.error.code,
            message: trim(scrubReasoningText(step.error.message), 400),
          },
    retryCount: 0,
    groupId,
  };
}

function groupTitle(statuses: readonly ActivityStatus[]): string {
  if (statuses.every((status) => status === 'succeeded')) return 'Wrote application files';
  if (statuses.some((status) => status === 'running' || status === 'pending'))
    return 'Writing application files';
  if (statuses.some((status) => status === 'failed')) return 'File changes, with failures';
  return 'File changes';
}

function groupStatus(statuses: readonly ActivityStatus[]): ActivityStatus {
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'awaiting_approval')) return 'awaiting_approval';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'pending')) return 'pending';
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled';
  return 'succeeded';
}

function elapsed(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Assigns sequence numbers and strips the internal grouping bookkeeping. */
function finalise(run: ReasoningRun, drafts: readonly Draft[]): AgentActivityEvent[] {
  return drafts.map((draft, position) => {
    const sequence = position + 1;
    return {
      eventId: `${draft.activityId}:${draft.status}`,
      runId: run.id,
      sequence,
      activityId: draft.activityId,
      parentActivityId: draft.parentActivityId,
      category: draft.category,
      title: draft.title,
      status: draft.status,
      safeSummary: draft.safeSummary,
      startedAt: draft.startedAt,
      completedAt: draft.completedAt,
      durationMs: draft.durationMs,
      safeInput: draft.safeInput,
      safeOutput: draft.safeOutput,
      error: draft.error,
      retryCount: draft.retryCount,
    };
  });
}

/** Validates and narrows a derived list, so only well-formed rows are streamed. */
export function safeActivities(activities: readonly AgentActivityEvent[]): AgentActivityEvent[] {
  return activities.filter(
    (activity) =>
      ACTIVITY_STATUSES.includes(activity.status) && Number.isInteger(activity.sequence),
  );
}

/**
 * The whole picture for one run, optionally only what came after a sequence.
 *
 * A reconnecting client calls this with the last sequence it holds: it gets the
 * rows it missed plus the run's current standing, in one reply. A fresh client
 * calls it with nothing and gets everything, which is why a page that reloads
 * mid-run still shows the work rather than an empty timeline.
 */
export function buildActivitySnapshot(run: ReasoningRun, after = 0): AgentActivitySnapshot {
  const activities = deriveRunActivities(run);
  const report = buildFinalReport(run, activities);
  const visible = activities.filter((activity) => activity.sequence > after);
  return {
    runId: run.id,
    sequence: activities.reduce((highest, activity) => Math.max(highest, activity.sequence), 0),
    runStatus: run.status,
    terminal: isTerminalRunStatus(run.status),
    activities: visible,
    report,
  };
}

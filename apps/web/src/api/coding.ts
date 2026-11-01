/**
 * Coding Agent client for the frontend builder (Step 32).
 *
 * The builder talks to the SAME coding agent every other surface uses: it
 * starts a bounded run, reads its state, approves or rejects the plan, answers
 * tool confirmations, and cancels. Nothing here can write a file directly -
 * file mutations happen inside the run, through the Tool System, with the plan
 * gate and revision protection intact.
 *
 * Everything is mapped into safe view models first: unknown payloads become a
 * typed error instead of reaching the UI, and only fields the server actually
 * reports are modeled. The plan is the agent's own declaration of intent; it is
 * rendered as text, never executed.
 */
import { apiRequest } from './client';

export type CodingRunState =
  | 'idle'
  | 'analyzing'
  | 'planning'
  | 'awaiting_approval'
  | 'inspecting'
  | 'editing'
  | 'validating'
  | 'iterating'
  | 'completed'
  | 'failed'
  | 'cancelled';

const RUN_STATES: readonly CodingRunState[] = [
  'idle',
  'analyzing',
  'planning',
  'awaiting_approval',
  'inspecting',
  'editing',
  'validating',
  'iterating',
  'completed',
  'failed',
  'cancelled',
];

export const TERMINAL_CODING_STATES: readonly CodingRunState[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isCodingRunTerminal(state: CodingRunState): boolean {
  return TERMINAL_CODING_STATES.includes(state);
}

export interface CodingPlanView {
  readonly goal: string;
  readonly steps: readonly string[];
  readonly filesToInspect: readonly string[];
  readonly filesToModify: readonly string[];
  readonly validations: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export type PendingApprovalView =
  | { readonly kind: 'plan_approval' }
  | { readonly kind: 'tool_confirmation'; readonly toolId: string };

export interface CodingRunView {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly state: CodingRunState;
  readonly summary: string | null;
  readonly changedFiles: readonly string[];
  readonly iterations: number;
  readonly toolCalls: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pendingApproval: PendingApprovalView | null;
  readonly plan: CodingPlanView | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface CodingCapabilities {
  /** 'scripted-demo' means no model is called for this API's agent. */
  readonly decisionSource: 'scripted-demo' | 'injected';
  readonly planApprovalRequired: boolean;
  readonly toolConfirmationsRequired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toPlan(raw: unknown, source: string): CodingPlanView | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new Error(`Invalid plan payload from ${source}`);
  return {
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    steps: stringList(raw.steps).length > 0 ? stringList(raw.steps) : planStepSummaries(raw.steps),
    filesToInspect: stringList(raw.filesToInspect),
    filesToModify: stringList(raw.filesToModify),
    validations: stringList(raw.validations),
    acceptanceCriteria: stringList(raw.acceptanceCriteria),
  };
}

/** Plan steps arrive as objects with a `summary`; accept either shape. */
function planStepSummaries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((step) => (isRecord(step) && typeof step.summary === 'string' ? step.summary : null))
    .filter((summary): summary is string => summary !== null);
}

function toApproval(raw: unknown): PendingApprovalView | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'plan_approval') return { kind: 'plan_approval' };
  if (raw.kind === 'tool_confirmation') {
    return { kind: 'tool_confirmation', toolId: typeof raw.toolId === 'string' ? raw.toolId : '' };
  }
  return null;
}

export function toCodingRunView(raw: unknown, source = 'coding agent'): CodingRunView {
  if (!isRecord(raw)) throw new Error(`Invalid run payload from ${source}`);
  const { runId, state } = raw;
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`Invalid run payload from ${source}`);
  }
  if (!RUN_STATES.includes(state as CodingRunState)) {
    throw new Error(`Invalid run payload from ${source}`);
  }
  const failure = isRecord(raw.failure)
    ? {
        code: typeof raw.failure.code === 'string' ? raw.failure.code : 'UNKNOWN',
        message: typeof raw.failure.message === 'string' ? raw.failure.message : '',
      }
    : null;
  return {
    runId,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    state: state as CodingRunState,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    changedFiles: stringList(raw.changedFiles),
    iterations: typeof raw.iterations === 'number' ? raw.iterations : 0,
    toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : 0,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    pendingApproval: toApproval(raw.pendingApproval),
    plan: toPlan(raw.plan, source),
    failure,
  };
}

export async function fetchCodingCapabilities(): Promise<CodingCapabilities> {
  const payload = await apiRequest<{ capabilities?: unknown }>('/api/coding/capabilities');
  const raw = isRecord(payload?.capabilities) ? payload.capabilities : {};
  return {
    decisionSource: raw.decisionSource === 'injected' ? 'injected' : 'scripted-demo',
    planApprovalRequired: raw.planApprovalRequired !== false,
    toolConfirmationsRequired: raw.toolConfirmationsRequired !== false,
  };
}

export interface StartCodingRunInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userRequirement: string;
  readonly targetFiles?: readonly string[];
  readonly constraints?: readonly string[];
}

export async function startCodingRun(input: StartCodingRunInput): Promise<CodingRunView> {
  const payload = await apiRequest<unknown>('/api/coding/runs', {
    method: 'POST',
    body: {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      userRequirement: input.userRequirement,
      ...(input.targetFiles === undefined ? {} : { targetFiles: [...input.targetFiles] }),
      ...(input.constraints === undefined ? {} : { constraints: [...input.constraints] }),
    },
  });
  return toCodingRunView(payload, 'start run');
}

export async function fetchCodingRun(runId: string): Promise<CodingRunView> {
  const payload = await apiRequest<unknown>(`/api/coding/runs/${encodeURIComponent(runId)}`);
  return toCodingRunView(payload, 'run status');
}

export async function cancelCodingRun(runId: string): Promise<CodingRunView> {
  const payload = await apiRequest<unknown>(
    `/api/coding/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', body: {} },
  );
  return toCodingRunView(payload, 'cancel run');
}

export async function submitCodingDecision(
  runId: string,
  decision: 'approve' | 'reject',
): Promise<CodingRunView> {
  const payload = await apiRequest<unknown>(
    `/api/coding/runs/${encodeURIComponent(runId)}/confirmation`,
    { method: 'POST', body: { decision } },
  );
  return toCodingRunView(payload, 'decision');
}

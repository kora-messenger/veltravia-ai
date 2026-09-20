/**
 * Preview runtime API surface + safe UI models (Step 17).
 *
 * Raw backend responses are mapped into typed views before reaching the
 * UI. The browser NEVER sends commands, ports, limits, or environment
 * values - the plan is detected server-side from workspace evidence, and
 * the client only issues lifecycle intents (create/start/stop/cancel/
 * restart/expire) against a runtime id.
 */
import { apiRequest } from './client';

const enc = encodeURIComponent;

export type RuntimeStatus =
  | 'created'
  | 'preparing'
  | 'building'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type RuntimeType = 'web' | 'fullstack' | 'backend' | 'mobile-preview';

export interface RuntimeFailureView {
  readonly kind: string;
  readonly phase: string;
  readonly message: string;
}

export interface RuntimePlanView {
  readonly runtimeType: RuntimeType;
  readonly revision: number;
  readonly buildLabel: string | null;
  readonly startLabel: string;
  readonly port: number;
  readonly evidence: readonly string[];
}

/** Safe UI model for a runtime record (safe fields only). */
export interface RuntimeView {
  readonly runtimeId: string;
  readonly workspaceId: string;
  readonly status: RuntimeStatus;
  readonly runtimeType: RuntimeType;
  readonly isolationLevel: 'simulated' | 'isolated';
  readonly executorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly previewUrl: string | null;
  readonly lastHealth: string | null;
  readonly failure: RuntimeFailureView | null;
  readonly revision: number;
  readonly currentRevision: number;
  readonly stale: boolean;
  readonly plan: RuntimePlanView;
}

export interface RuntimeLogEntryView {
  readonly timestamp: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly phase: string;
  readonly message: string;
}

const RUNTIME_COMMAND_LABELS: Readonly<Record<string, string>> = {
  created: 'Preparing…',
  preparing: 'Preparing…',
  building: 'Building…',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export function runtimeStatusLabel(status: RuntimeStatus): string {
  return RUNTIME_COMMAND_LABELS[status] ?? status;
}

export function isLiveRuntimeStatus(status: RuntimeStatus): boolean {
  return (
    status === 'created' ||
    status === 'preparing' ||
    status === 'building' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'stopping'
  );
}

function toRuntimeView(raw: Record<string, unknown>): RuntimeView {
  const plan = (raw.plan ?? {}) as Record<string, unknown>;
  const buildCommand = (plan.buildCommand ?? null) as Record<string, unknown> | null;
  const startCommand = (plan.startCommand ?? {}) as Record<string, unknown>;
  return {
    runtimeId: String(raw.runtimeId ?? ''),
    workspaceId: String(raw.workspaceId ?? ''),
    status: (raw.status ?? 'created') as RuntimeStatus,
    runtimeType: (raw.runtimeType ?? 'web') as RuntimeType,
    isolationLevel: (raw.isolationLevel ?? 'simulated') as 'simulated' | 'isolated',
    executorId: String(raw.executorId ?? ''),
    createdAt: String(raw.createdAt ?? ''),
    expiresAt: String(raw.expiresAt ?? ''),
    previewUrl: typeof raw.previewUrl === 'string' ? raw.previewUrl : null,
    lastHealth: typeof raw.lastHealth === 'string' ? raw.lastHealth : null,
    failure: (raw.failure ?? null) as RuntimeFailureView | null,
    revision: Number(raw.revision ?? 0),
    currentRevision: Number(raw.currentRevision ?? 0),
    stale: Boolean(raw.stale),
    plan: {
      runtimeType: (plan.runtimeType ?? 'web') as RuntimeType,
      revision: Number(plan.expectedRevision ?? 0),
      buildLabel:
        buildCommand !== null
          ? String(buildCommand.label ?? buildCommand.executable ?? 'build')
          : null,
      startLabel: String(startCommand.label ?? startCommand.executable ?? 'start'),
      port: Number(plan.port ?? 0),
      evidence: Array.isArray(plan.evidence) ? plan.evidence.map((line) => String(line)) : [],
    },
  };
}

/** Lists runtimes for a project (optionally scoped to one workspace). */
export async function listRuntimes(
  projectId: string,
  options: { readonly workspaceId?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly RuntimeView[]> {
  const query = options.workspaceId !== undefined ? `?workspaceId=${enc(options.workspaceId)}` : '';
  const body = await apiRequest<{ runtimes: Record<string, unknown>[] }>(
    `/api/projects/${enc(projectId)}/runtimes${query}`,
    { ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
  );
  return (body.runtimes ?? []).map(toRuntimeView);
}

/** Creates a runtime (the plan is detected server-side). */
export async function createRuntime(
  projectId: string,
  input: { readonly workspaceId: string; readonly fetchImpl?: typeof fetch },
): Promise<RuntimeView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/runtimes`,
    {
      method: 'POST',
      body: { workspaceId: input.workspaceId },
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  return toRuntimeView(raw);
}

/** Lifecycle intents - the browser only ever sends the runtime id. */
export async function startRuntime(
  projectId: string,
  runtimeId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<RuntimeView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/runtimes/${enc(runtimeId)}/start`,
    {
      method: 'POST',
      body: {},
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  return toRuntimeView(raw);
}

export async function stopRuntime(
  projectId: string,
  runtimeId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<RuntimeView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/runtimes/${enc(runtimeId)}/stop`,
    {
      method: 'POST',
      body: {},
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  return toRuntimeView(raw);
}

export async function restartRuntime(
  projectId: string,
  runtimeId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<{ readonly next: RuntimeView; readonly previous: RuntimeView }> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/runtimes/${enc(runtimeId)}/restart`,
    {
      method: 'POST',
      body: {},
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  return {
    next: toRuntimeView((raw.next ?? {}) as Record<string, unknown>),
    previous: toRuntimeView((raw.previous ?? {}) as Record<string, unknown>),
  };
}

/** Bounded log snapshot for one runtime. UNTRUSTED display data, never executed. */
export async function fetchRuntimeLogs(
  projectId: string,
  runtimeId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<{ readonly entries: readonly RuntimeLogEntryView[]; readonly truncated: boolean }> {
  const body = await apiRequest<{
    entries: Record<string, unknown>[];
    truncated: boolean;
  }>(`/api/projects/${enc(projectId)}/runtimes/${enc(runtimeId)}/logs`, {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    entries: (body.entries ?? []).map((entry) => ({
      timestamp: String(entry.timestamp ?? ''),
      level: (entry.level ?? 'info') as RuntimeLogEntryView['level'],
      phase: String(entry.phase ?? ''),
      message: String(entry.message ?? ''),
    })),
    truncated: Boolean(body.truncated),
  };
}

/** One bounded health probe. */
export async function fetchRuntimeHealth(
  projectId: string,
  runtimeId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<{ readonly status: string; readonly message: string }> {
  return apiRequest(`/api/projects/${enc(projectId)}/runtimes/${enc(runtimeId)}/health`, {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

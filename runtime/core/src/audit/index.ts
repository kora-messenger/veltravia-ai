/**
 * Runtime audit events - scrubbed lifecycle evidence (Step 17).
 *
 * Audit events record WHAT happened to which runtime (ids, statuses, kinds)
 * and never carry application output, environment values, credentials, or
 * infrastructure internals. The sink is injected; the core never logs to
 * the host by itself.
 */

export const RUNTIME_AUDIT_EVENT_TYPES = [
  'runtime.created',
  'runtime.started',
  'runtime.stopped',
  'runtime.restart_created',
  'runtime.failed',
  'runtime.expired',
  'runtime.cancelled',
  'runtime.swept',
] as const;

export type RuntimeAuditEventType = (typeof RUNTIME_AUDIT_EVENT_TYPES)[number];

export interface RuntimeAuditEvent {
  readonly type: RuntimeAuditEventType;
  readonly timestamp: string;
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type RuntimeAuditSink = (event: RuntimeAuditEvent) => void;

export function createRuntimeAuditEvent(input: {
  type: RuntimeAuditEventType;
  timestamp: string;
  runtimeId: string;
  projectId: string;
  workspaceId: string;
  revision: number;
  details?: Record<string, string | number | boolean | null>;
}): RuntimeAuditEvent {
  return {
    type: input.type,
    timestamp: input.timestamp,
    runtimeId: input.runtimeId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    revision: input.revision,
    details: Object.freeze({ ...(input.details ?? {}) }),
  };
}

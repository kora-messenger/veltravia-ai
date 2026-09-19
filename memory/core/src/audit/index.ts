/**
 * Bounded audit events for the Project Memory & Knowledge System. Events
 * carry ids, project scoping, counts, and outcome codes - never memory
 * content, never secret-shaped values, never full text dumps.
 */

export const MEMORY_AUDIT_EVENT_TYPES = [
  'memory_created',
  'memory_updated',
  'memory_archived',
  'memory_restored',
  'memory_deleted',
  'memory_verified',
  'memory_marked_stale',
  'memory_candidate_created',
  'memory_candidate_approved',
  'memory_candidate_rejected',
  'memory_context_built',
] as const;

export type MemoryAuditEventType = (typeof MEMORY_AUDIT_EVENT_TYPES)[number];

export interface MemoryAuditEvent {
  readonly type: MemoryAuditEventType;
  readonly memoryId: string | null;
  readonly projectId: string;
  readonly at: string;
  /** Bounded metadata: type names, counts, revisions - never content. */
  readonly data: Readonly<Record<string, unknown>>;
}

export type MemoryAuditSink = (event: MemoryAuditEvent) => void;

/** A no-op sink (the default when no sink is injected). */
export const nullMemoryAuditSink: MemoryAuditSink = () => undefined;

/** Collects events in memory (tests and bounded development inspection). */
export function createMemoryAuditCollector(): {
  readonly sink: MemoryAuditSink;
  readonly events: readonly MemoryAuditEvent[];
  readonly clear: () => void;
} {
  const events: MemoryAuditEvent[] = [];
  return {
    sink: (event) => {
      events.push(event);
    },
    get events() {
      return [...events];
    },
    clear: () => {
      events.length = 0;
    },
  };
}

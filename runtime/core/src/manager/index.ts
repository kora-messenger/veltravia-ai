/**
 * RuntimeManager - preview lifecycle + policy enforcement (Step 17).
 *
 * The manager NEVER builds or serves anything itself: every build/start/
 * health/stop operation flows through the injected RuntimeExecutor (the
 * isolation boundary). The manager's job is to validate everything, enforce
 * the lifecycle state machine, bind runtimes to a workspace revision, bound
 * logs, enforce hard limits (per-workspace runtime count, global active
 * ceiling, lifetime + idle expiry), and emit scrubbed audit events.
 *
 * Revision binding: a runtime is pinned to the workspace revision it was
 * planned against. When the workspace moves forward the runtime is reported
 * STALE (never silently re-based); a restart creates a NEW runtime at the
 * latest revision and stops the old one.
 */

import {
  createRuntimeAuditEvent,
  type RuntimeAuditEvent,
  type RuntimeAuditSink,
} from '../audit/index.js';
import type { RuntimeDetectionEvidence } from '../detection/index.js';
import { detectRuntimePlan } from '../detection/index.js';
import {
  InvalidRuntimeRequestError,
  RuntimeExpiredError,
  RuntimeLimitExceededError,
  RuntimeNotFoundError,
  RuntimeRevisionMismatchError,
  isRuntimeError,
} from '../errors/index.js';
import type { RuntimeExecutor } from '../executor/index.js';
import { RuntimeLogBuffer } from '../logs/index.js';
import { validateRuntimePlan } from '../plan/index.js';
import { assertRuntimeTransition, isLiveRuntimeStatus } from '../state/index.js';
import {
  ACTIVE_RUNTIME_TYPES,
  RUNTIME_STATES,
  type RuntimeId,
  type RuntimeRecord,
  type RuntimeStatus,
  type RuntimeType,
  type RuntimeView,
} from '../types/index.js';

/** Hard ceilings enforced by the manager regardless of plan limits. */
export const MAX_RUNTIMES_PER_WORKSPACE = 5;
export const MAX_ACTIVE_RUNTIMES = 50;
/** The largest revision delta we report before calling a runtime stale (0 = any change). */
export const PREVIEW_URL_PREFIX = '/preview';

/**
 * The narrow gateway the manager needs into the Project Engine. The API
 * supplies an adapter; runtime/core depends on nothing.
 */
export interface RuntimeWorkspaceGateway {
  /** Workspace facts; unknown ids must throw (mapped to 404 by the API). */
  getWorkspace(workspaceId: string): Promise<{
    readonly projectId: string;
    readonly revision: number;
    readonly status: 'active' | 'archived' | 'locked';
  }>;
  /** Workspace-relative file paths present (bounded, metadata only). */
  listWorkspaceFiles(workspaceId: string): Promise<readonly string[]>;
  /** Project existence check for ownership scoping. */
  projectExists(projectId: string): Promise<boolean>;
}

/** Assembles detection evidence for a workspace (API wires this to the Project Engine + Codebase Intelligence). */
export type RuntimeEvidenceProvider = (
  workspaceId: string,
  requestedType: RuntimeType | undefined,
) => Promise<RuntimeDetectionEvidence>;

interface ManagedRuntime {
  record: RuntimeRecord;
  logs: RuntimeLogBuffer;
  lastActivityAt: Date;
  cancelled: boolean;
  /** Simulated-behavior selector handed to the executor (mock scenarios). */
  readonly scenario?: string;
}

export interface RuntimeManagerOptions {
  readonly executor: RuntimeExecutor;
  readonly gateway: RuntimeWorkspaceGateway;
  readonly evidenceProvider: RuntimeEvidenceProvider;
  readonly now?: () => Date;
  readonly auditSink?: RuntimeAuditSink;
  readonly generateRuntimeId?: () => RuntimeId;
  /** Resolves a project display name for the preview page (defaults to the id). */
  readonly projectNameProvider?: (projectId: string) => Promise<string>;
}

export class RuntimeManager {
  private readonly executor: RuntimeExecutor;
  private readonly gateway: RuntimeWorkspaceGateway;
  private readonly evidenceProvider: RuntimeEvidenceProvider;
  private readonly now: () => Date;
  private readonly auditSink?: RuntimeAuditSink;
  private readonly generateRuntimeId: () => RuntimeId;
  private readonly projectNameProvider: (projectId: string) => Promise<string>;
  private readonly runtimes = new Map<RuntimeId, ManagedRuntime>();

  constructor(options: RuntimeManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new InvalidRuntimeRequestError('manager options are required');
    }
    if (!options.executor || typeof options.executor.build !== 'function') {
      throw new InvalidRuntimeRequestError('a RuntimeExecutor is required');
    }
    if (!options.gateway || typeof options.gateway.getWorkspace !== 'function') {
      throw new InvalidRuntimeRequestError('a workspace gateway is required');
    }
    if (typeof options.evidenceProvider !== 'function') {
      throw new InvalidRuntimeRequestError('an evidence provider is required');
    }
    this.executor = options.executor;
    this.gateway = options.gateway;
    this.evidenceProvider = options.evidenceProvider;
    this.now = options.now ?? (() => new Date());
    this.auditSink = options.auditSink;
    this.generateRuntimeId =
      options.generateRuntimeId ?? (() => `rt_${Math.random().toString(36).slice(2, 12)}`);
    this.projectNameProvider = options.projectNameProvider ?? (async (projectId) => projectId);
  }

  // ---------------------------------------------------------------- helpers

  private audit(
    event: Omit<RuntimeAuditEvent, 'timestamp' | 'details'> & {
      details?: Record<string, string | number | boolean | null>;
    },
  ): void {
    this.auditSink?.(
      createRuntimeAuditEvent({
        ...event,
        details: event.details,
        timestamp: this.now().toISOString(),
      }),
    );
  }

  private require(runtimeId: string): ManagedRuntime {
    const managed = this.runtimes.get(runtimeId);
    if (!managed) {
      throw new RuntimeNotFoundError(runtimeId);
    }
    return managed;
  }

  private handle(managed: ManagedRuntime) {
    return {
      runtimeId: managed.record.runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
      plan: managed.record.plan,
      ...(managed.scenario !== undefined ? { scenario: managed.scenario } : {}),
    };
  }

  private transition(managed: ManagedRuntime, to: RuntimeStatus): void {
    assertRuntimeTransition(managed.record.status, to);
    managed.record = { ...managed.record, status: to };
  }

  private async toView(managed: ManagedRuntime): Promise<RuntimeView> {
    const workspace = await this.gateway.getWorkspace(managed.record.workspaceId).catch(() => null);
    const currentRevision = workspace ? workspace.revision : managed.record.revision;
    return {
      runtimeId: managed.record.runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
      status: managed.record.status,
      runtimeType: managed.record.runtimeType,
      isolationLevel: managed.record.isolationLevel,
      executorId: managed.record.executorId,
      createdAt: managed.record.createdAt,
      startedAt: managed.record.startedAt,
      stoppedAt: managed.record.stoppedAt,
      expiresAt: managed.record.expiresAt,
      previewUrl: managed.record.previewUrl,
      lastHealth: managed.record.lastHealth,
      failure: managed.record.failure,
      currentRevision,
      stale: currentRevision !== managed.record.revision,
      plan: managed.record.plan,
    };
  }

  private log(
    managed: ManagedRuntime,
    level: 'info' | 'warning' | 'error',
    phase: 'prepare' | 'build' | 'start' | 'health' | 'run' | 'stop' | 'expire',
    message: string,
  ): void {
    managed.logs.append(this.now, level, phase, message);
  }

  /** Active count against the global ceiling. */
  private activeCount(): number {
    let count = 0;
    for (const managed of this.runtimes.values()) {
      if (isLiveRuntimeStatus(managed.record.status)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Lazy expiry sweep: runtimes past expiresAt or idle beyond idleTimeoutMs
   * transition to 'expired' and release their executor slot. Called on
   * every manager operation (in-process store - documented limitation).
   */
  async sweepExpired(): Promise<number> {
    const now = this.now();
    let swept = 0;
    for (const managed of this.runtimes.values()) {
      if (!isLiveRuntimeStatus(managed.record.status)) {
        continue;
      }
      const expiresAt = Date.parse(managed.record.expiresAt);
      const idleDeadline =
        managed.lastActivityAt.getTime() + managed.record.plan.limits.idleTimeoutMs;
      if (now.getTime() >= expiresAt || now.getTime() >= idleDeadline) {
        this.log(managed, 'info', 'expire', 'runtime expired (lifetime or idle timeout reached)');
        await this.executor.stop(this.handle(managed));
        this.transition(managed, 'expired');
        managed.record = { ...managed.record, stoppedAt: now.toISOString() };
        this.audit({
          type: 'runtime.expired',
          runtimeId: managed.record.runtimeId,
          projectId: managed.record.projectId,
          workspaceId: managed.record.workspaceId,
          revision: managed.record.revision,
        });
        swept += 1;
      }
    }
    return swept;
  }

  // ---------------------------------------------------------------- create

  /** Creates a runtime in 'created' state with a DETECTED, validated plan. */
  async create(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly runtimeType?: RuntimeType;
    readonly scenario?: string;
  }): Promise<RuntimeView> {
    await this.sweepExpired();
    if (!input || typeof input !== 'object') {
      throw new InvalidRuntimeRequestError('create input must be an object');
    }
    if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
      throw new InvalidRuntimeRequestError('projectId is required');
    }
    if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
      throw new InvalidRuntimeRequestError('workspaceId is required');
    }
    if (!(await this.gateway.projectExists(input.projectId))) {
      throw new InvalidRuntimeRequestError(`project "${input.projectId}" was not found`, {
        projectId: input.projectId,
      });
    }
    const workspace = await this.gateway.getWorkspace(input.workspaceId);
    if (workspace.projectId !== input.projectId) {
      throw new InvalidRuntimeRequestError('the workspace does not belong to this project', {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      });
    }
    if (workspace.status !== 'active') {
      throw new InvalidRuntimeRequestError(
        `the workspace is ${workspace.status} and cannot be previewed`,
        { workspaceId: input.workspaceId, status: workspace.status },
      );
    }

    let perWorkspace = 0;
    for (const managed of this.runtimes.values()) {
      if (managed.record.workspaceId === input.workspaceId) {
        perWorkspace += 1;
      }
    }
    if (perWorkspace >= MAX_RUNTIMES_PER_WORKSPACE) {
      throw new RuntimeLimitExceededError(
        `workspace already holds ${perWorkspace} runtimes (max ${MAX_RUNTIMES_PER_WORKSPACE}) - stop or restart one first`,
        { workspaceId: input.workspaceId },
      );
    }
    if (this.activeCount() >= MAX_ACTIVE_RUNTIMES) {
      throw new RuntimeLimitExceededError(
        `the platform is hosting ${MAX_ACTIVE_RUNTIMES} active runtimes - stop one before starting another`,
      );
    }

    const evidence = await this.evidenceProvider(input.workspaceId, input.runtimeType);
    const plan = validateRuntimePlan(detectRuntimePlan(evidence));

    // Required files must exist at THIS revision before any runtime exists.
    const presentFiles = await this.gateway.listWorkspaceFiles(input.workspaceId);
    const missing = plan.requiredFiles.filter((path) => !presentFiles.includes(path));
    if (missing.length > 0) {
      throw new InvalidRuntimeRequestError(
        `the plan requires files that are not present: ${missing.join(', ')}`,
        { missing: [...missing] },
      );
    }

    const now = this.now();
    const runtimeId = this.generateRuntimeId();
    const record: RuntimeRecord = {
      runtimeId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      revision: workspace.revision,
      status: 'created',
      runtimeType: plan.runtimeType,
      plan,
      createdAt: now.toISOString(),
      startedAt: null,
      stoppedAt: null,
      expiresAt: new Date(now.getTime() + plan.limits.maxLifetimeMs).toISOString(),
      previewUrl: null,
      lastHealth: null,
      failure: null,
      isolationLevel: this.executor.isolationLevel,
      executorId: this.executor.executorId,
    };
    const managed: ManagedRuntime = {
      record,
      logs: new RuntimeLogBuffer(plan.limits.maxLogBytes),
      lastActivityAt: now,
      cancelled: false,
      ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
    };
    this.runtimes.set(runtimeId, managed);
    this.log(
      managed,
      'info',
      'prepare',
      `runtime created at revision ${workspace.revision} (${plan.runtimeType} preview)`,
    );
    this.log(
      managed,
      'info',
      'prepare',
      `preview served by ${this.executor.executorId} (isolation: ${this.executor.isolationLevel})`,
    );
    this.audit({
      type: 'runtime.created',
      runtimeId,
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      revision: record.revision,
      details: { runtimeType: record.runtimeType, isolationLevel: record.isolationLevel },
    });
    return this.toView(managed);
  }

  // ---------------------------------------------------------------- start

  /**
   * Full controlled start: preparing -> (build) -> starting -> bounded health
   * checks -> running. Any phase failure transitions to 'failed' with a
   * structured, scrubbed report; a broken runtime is never left running.
   */
  async start(runtimeId: string): Promise<RuntimeView> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    const workspace = await this.gateway.getWorkspace(managed.record.workspaceId);
    if (managed.record.status !== 'created' && managed.record.status !== 'stopped') {
      throw new InvalidRuntimeRequestError(
        `runtime "${runtimeId}" is in state "${managed.record.status}" - only created or stopped runtimes can start`,
        { runtimeId, status: managed.record.status },
      );
    }
    if (workspace.revision !== managed.record.revision) {
      throw new RuntimeRevisionMismatchError(
        runtimeId,
        managed.record.revision,
        workspace.revision,
      );
    }
    if (this.activeCount() >= MAX_ACTIVE_RUNTIMES) {
      throw new RuntimeLimitExceededError(
        `the platform is hosting ${MAX_ACTIVE_RUNTIMES} active runtimes - stop one before starting another`,
      );
    }

    // A stopped runtime re-uses its original record: reset lifecycle fields.
    if (managed.record.status === 'stopped') {
      managed.record = {
        ...managed.record,
        status: 'created',
        failure: null,
        lastHealth: null,
      };
    }
    managed.cancelled = false;

    // ---- preparing
    this.transition(managed, 'preparing');
    this.log(
      managed,
      'info',
      'prepare',
      `preparing preview at revision ${managed.record.revision}`,
    );
    const handle = this.handle(managed);

    // ---- build (optional)
    if (managed.record.plan.buildCommand !== null) {
      this.transition(managed, 'building');
      const started = this.now().getTime();
      const build = await this.executor.build(handle);
      const durationMs = this.now().getTime() - started;
      for (const line of build.logs) {
        this.log(managed, line.level, line.phase, line.message);
      }
      if (managed.cancelled) {
        await this.executor.stop(handle);
        this.transition(managed, 'cancelled');
        managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
        this.audit({
          type: 'runtime.cancelled',
          runtimeId,
          projectId: managed.record.projectId,
          workspaceId: managed.record.workspaceId,
          revision: managed.record.revision,
        });
        return this.toView(managed);
      }
      if (!build.ok) {
        await this.executor.stop(handle);
        this.transition(managed, 'failed');
        managed.record = {
          ...managed.record,
          failure: {
            kind: build.failureKind ?? 'build_failed',
            phase: 'build',
            message: build.message,
            affectedPaths: [],
          },
        };
        this.log(managed, 'error', 'build', `build failed: ${build.message}`);
        this.audit({
          type: 'runtime.failed',
          runtimeId,
          projectId: managed.record.projectId,
          workspaceId: managed.record.workspaceId,
          revision: managed.record.revision,
          details: { kind: build.failureKind ?? 'build_failed', phase: 'build' },
        });
        return this.toView(managed);
      }
      this.log(managed, 'info', 'build', `build completed in ${durationMs}ms`);
    }

    // ---- starting
    this.transition(managed, 'starting');
    const startResult = await this.executor.start(handle);
    for (const line of startResult.logs) {
      this.log(managed, line.level, line.phase, line.message);
    }
    if (managed.cancelled) {
      await this.executor.stop(handle);
      this.transition(managed, 'cancelled');
      managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
      this.audit({
        type: 'runtime.cancelled',
        runtimeId,
        projectId: managed.record.projectId,
        workspaceId: managed.record.workspaceId,
        revision: managed.record.revision,
      });
      return this.toView(managed);
    }
    if (!startResult.ok || startResult.previewToken === null) {
      await this.executor.stop(handle);
      this.transition(managed, 'failed');
      managed.record = {
        ...managed.record,
        failure: {
          kind: startResult.failureKind ?? 'start_failed',
          phase: 'start',
          message: startResult.message,
          affectedPaths: [],
        },
      };
      this.log(managed, 'error', 'start', `start failed: ${startResult.message}`);
      this.audit({
        type: 'runtime.failed',
        runtimeId,
        projectId: managed.record.projectId,
        workspaceId: managed.record.workspaceId,
        revision: managed.record.revision,
        details: { kind: startResult.failureKind ?? 'start_failed', phase: 'start' },
      });
      return this.toView(managed);
    }

    // ---- bounded health checks (NEVER an unbounded poll loop)
    const { healthCheck } = managed.record.plan;
    let checks = 0;
    for (;;) {
      checks += 1;
      const health = await this.executor.health(handle);
      managed.record = { ...managed.record, lastHealth: health.status };
      if (health.status === 'healthy') {
        this.log(managed, 'info', 'health', `preview healthy after ${checks} check(s)`);
        break;
      }
      if (managed.cancelled) {
        await this.executor.stop(handle);
        this.transition(managed, 'cancelled');
        managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
        this.audit({
          type: 'runtime.cancelled',
          runtimeId,
          projectId: managed.record.projectId,
          workspaceId: managed.record.workspaceId,
          revision: managed.record.revision,
        });
        return this.toView(managed);
      }
      if (checks >= healthCheck.maxChecks) {
        await this.executor.stop(handle);
        this.transition(managed, 'failed');
        managed.record = {
          ...managed.record,
          failure: {
            kind:
              health.status === 'unhealthy' || health.status === 'failed'
                ? 'health_failed'
                : 'start_timeout',
            phase: 'health',
            message: `preview did not become healthy within ${healthCheck.maxChecks} checks: ${health.message}`,
            affectedPaths: [],
          },
        };
        this.log(managed, 'error', 'health', 'health checks exhausted without a healthy preview');
        this.audit({
          type: 'runtime.failed',
          runtimeId,
          projectId: managed.record.projectId,
          workspaceId: managed.record.workspaceId,
          revision: managed.record.revision,
          details: { kind: 'health_failed', phase: 'health', checks },
        });
        return this.toView(managed);
      }
    }

    // ---- running
    this.transition(managed, 'running');
    const startedAt = this.now().toISOString();
    managed.record = {
      ...managed.record,
      startedAt,
      previewUrl: `${PREVIEW_URL_PREFIX}/${runtimeId}`,
    };
    managed.lastActivityAt = this.now();
    this.log(managed, 'info', 'run', `preview running at ${managed.record.previewUrl}`);
    this.audit({
      type: 'runtime.started',
      runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
    });
    return this.toView(managed);
  }

  // ---------------------------------------------------------------- stop / cancel / restart

  /** Stops a live runtime. Terminal for the record (restart creates a new one). */
  async stop(runtimeId: string): Promise<RuntimeView> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    if (!isLiveRuntimeStatus(managed.record.status)) {
      throw new InvalidRuntimeRequestError(
        `runtime "${runtimeId}" is in state "${managed.record.status}" - nothing to stop`,
        { runtimeId, status: managed.record.status },
      );
    }
    await this.executor.stop(this.handle(managed));
    this.transition(managed, 'stopping');
    this.transition(managed, 'stopped');
    managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
    this.log(managed, 'info', 'stop', 'runtime stopped');
    this.audit({
      type: 'runtime.stopped',
      runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
    });
    return this.toView(managed);
  }

  /** One-way cancellation from any live state. */
  async cancel(runtimeId: string): Promise<RuntimeView> {
    const managed = this.require(runtimeId);
    if (!isLiveRuntimeStatus(managed.record.status)) {
      throw new InvalidRuntimeRequestError(
        `runtime "${runtimeId}" is in state "${managed.record.status}" - cancellation applies to live runtimes`,
        { runtimeId, status: managed.record.status },
      );
    }
    managed.cancelled = true;
    await this.executor.stop(this.handle(managed));
    if (isLiveRuntimeStatus(managed.record.status)) {
      // Cancel from a state the state machine allows (preparing/starting).
      this.transition(managed, 'cancelled');
      managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
    }
    this.log(managed, 'info', 'stop', 'runtime cancelled');
    this.audit({
      type: 'runtime.cancelled',
      runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
    });
    return this.toView(managed);
  }

  /**
   * Restart = stop the old runtime (if live), then create AND start a NEW
   * runtime at the CURRENT workspace revision (fresh detection). The old
   * record stays stopped/expired; the new one carries the new revision.
   */
  async restart(runtimeId: string): Promise<{ previous: RuntimeView; next: RuntimeView }> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    let previous: RuntimeView;
    if (isLiveRuntimeStatus(managed.record.status)) {
      previous = await this.stop(runtimeId);
    } else {
      previous = await this.toView(managed);
    }
    // One preview per workspace: a restart also retires any OTHER live
    // runtime of the same workspace (restarting a stopped runtime while
    // a newer one runs must never leave two concurrent previews).
    for (const other of this.runtimes.values()) {
      if (
        other !== managed &&
        other.record.projectId === managed.record.projectId &&
        other.record.workspaceId === managed.record.workspaceId &&
        isLiveRuntimeStatus(other.record.status)
      ) {
        await this.stop(other.record.runtimeId);
      }
    }
    const scenario = managed.scenario;
    const next = await this.create({
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      ...(scenario !== undefined ? { scenario } : {}),
    });
    const started = await this.start(next.runtimeId);
    this.audit({
      type: 'runtime.restart_created',
      runtimeId: started.runtimeId,
      projectId: started.projectId,
      workspaceId: started.workspaceId,
      revision: started.revision,
      details: { previousRuntimeId: runtimeId },
    });
    return { previous, next: started };
  }

  // ---------------------------------------------------------------- reads

  async get(runtimeId: string): Promise<RuntimeView> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    managed.lastActivityAt = this.now();
    return this.toView(managed);
  }

  async list(input: {
    readonly projectId: string;
    readonly workspaceId?: string;
  }): Promise<readonly RuntimeView[]> {
    await this.sweepExpired();
    const views: RuntimeView[] = [];
    for (const managed of this.runtimes.values()) {
      if (managed.record.projectId !== input.projectId) {
        continue;
      }
      if (input.workspaceId !== undefined && managed.record.workspaceId !== input.workspaceId) {
        continue;
      }
      views.push(await this.toView(managed));
    }
    views.sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return a.runtimeId < b.runtimeId ? 1 : -1;
    });
    return views;
  }

  /** Bounded log snapshot. Reading logs refreshes idle activity. */
  async logs(runtimeId: string): Promise<{
    entries: readonly import('../types/index.js').RuntimeLogEntry[];
    truncated: boolean;
  }> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    managed.lastActivityAt = this.now();
    return managed.logs.snapshot();
  }

  /** Explicit expiry (user- or operator-triggered). */
  async expire(runtimeId: string): Promise<RuntimeView> {
    const managed = this.require(runtimeId);
    if (!isLiveRuntimeStatus(managed.record.status)) {
      throw new RuntimeExpiredError(runtimeId);
    }
    await this.executor.stop(this.handle(managed));
    this.transition(managed, 'expired');
    managed.record = { ...managed.record, stoppedAt: this.now().toISOString() };
    this.log(managed, 'info', 'expire', 'runtime expired by request');
    this.audit({
      type: 'runtime.expired',
      runtimeId,
      projectId: managed.record.projectId,
      workspaceId: managed.record.workspaceId,
      revision: managed.record.revision,
    });
    return this.toView(managed);
  }

  /** Cleanup: removes terminal records from the in-process store. */
  async cleanup(input: { readonly projectId?: string }): Promise<number> {
    let removed = 0;
    for (const [runtimeId, managed] of this.runtimes.entries()) {
      if (isLiveRuntimeStatus(managed.record.status)) {
        continue;
      }
      if (input?.projectId !== undefined && managed.record.projectId !== input.projectId) {
        continue;
      }
      this.runtimes.delete(runtimeId);
      removed += 1;
    }
    return removed;
  }

  /** Health of a running runtime (single bounded probe - no polling here). */
  async health(
    runtimeId: string,
  ): Promise<{ status: import('../types/index.js').RuntimeHealthStatus; message: string }> {
    const managed = this.require(runtimeId);
    if (managed.record.status !== 'running') {
      return { status: 'stopped', message: `runtime is "${managed.record.status}"` };
    }
    const report = await this.executor.health(this.handle(managed));
    managed.record = { ...managed.record, lastHealth: report.status };
    managed.lastActivityAt = this.now();
    return { status: report.status, message: report.message };
  }

  /** Preview access: verifies the runtime is running and fresh; refreshes idle. */
  async openPreview(runtimeId: string): Promise<{
    previewUrl: string;
    meta: { projectName: string; isolationLevel: 'simulated' | 'isolated'; executorId: string };
  }> {
    await this.sweepExpired();
    const managed = this.require(runtimeId);
    if (managed.record.status !== 'running' || managed.record.previewUrl === null) {
      throw new InvalidRuntimeRequestError(
        `runtime "${runtimeId}" is not running - start it before opening the preview`,
        { runtimeId, status: managed.record.status },
      );
    }
    managed.lastActivityAt = this.now();
    const projectName = await this.projectNameProvider(managed.record.projectId);
    return {
      previewUrl: managed.record.previewUrl,
      meta: {
        projectName,
        isolationLevel: managed.record.isolationLevel,
        executorId: managed.record.executorId,
      },
    };
  }

  /**
   * Renders the preview page content through the executor (the real runtime
   * record handle - never a fabricated one). The executor decides what
   * renders; the mock shows an explicitly-labeled SIMULATED page over the
   * plan's bounded metadata.
   */
  async renderPreview(runtimeId: string): Promise<string> {
    const preview = await this.openPreview(runtimeId);
    const managed = this.require(runtimeId);
    return this.executor.previewContent(this.handle(managed), preview.meta);
  }

  /** The executor behind this manager (API uses it to render preview content). */
  get runtimeExecutor(): RuntimeExecutor {
    return this.executor;
  }

  /** For tests: state legality guard is exported logic, not internals. */
  static readonly states = RUNTIME_STATES;
  static readonly activeTypes = ACTIVE_RUNTIME_TYPES;
}

export function isRuntimeManagerError(error: unknown): boolean {
  return isRuntimeError(error);
}

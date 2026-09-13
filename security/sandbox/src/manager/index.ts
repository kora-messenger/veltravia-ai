/**
 * SandboxManager - lifecycle + policy enforcement. NEVER executes commands.
 *
 * All execution flows through the injected SandboxRuntime (the isolation
 * boundary). The manager's job is: validate everything, enforce the
 * lifecycle, enforce the command/network/environment/limit policies,
 * bound and scrub output, record executions, and emit scrubbed audit
 * events. It has no method that can change a sandbox's profile or limits
 * after creation - policy is pinned at creation and is immutable data.
 */

import {
  ExecutionNotFoundError,
  InvalidSandboxRequestError,
  SandboxExpiredError,
  SandboxNotFoundError,
  SandboxNotReadyError,
  isSandboxError,
} from '../errors/index.js';
import {
  assertExecutionTransition,
  assertSandboxTransition,
  isSandboxExecutable,
} from '../lifecycle/index.js';
import {
  assertCommandAllowed,
  validateArguments,
  validateCommandPolicy,
} from '../commands/index.js';
import { buildIsolatedEnvironment, validateDefaultEnvironment } from '../environment/index.js';
import { assertExecutionNetworkPolicy, validateNetworkPolicy } from '../network/index.js';
import { normalizeWorkspaceRelativePath, validateWorkspaceRef } from '../paths/index.js';
import { sanitizeOutput } from '../output/index.js';
import {
  DEFAULT_RESOURCE_LIMITS,
  resolveExecutionLimits,
  validateResourceLimits,
} from '../validation/index.js';
import {
  createSandboxAuditEvent,
  type SandboxAuditEventType,
  type SandboxAuditSink,
} from '../audit/index.js';
import type { SandboxRuntime } from '../runtime/index.js';
import type {
  ExecutionId,
  ExecutionStatus,
  ResourceLimits,
  RuntimeExecutionOutcome,
  RuntimeExecutionRequest,
  SandboxExecutionRecord,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxId,
  SandboxProfile,
  SandboxRecord,
  SandboxStatus,
} from '../types/index.js';

/** Safe default command allowlist for development profiles. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = ['node', 'npm', 'npx', 'python', 'pip'];

/** Default sandbox TTL: one hour. A sandbox must not live forever. */
export const DEFAULT_TTL_MS = 3_600_000;
export const MAX_TTL_MS = 86_400_000;

export interface SandboxManagerOptions {
  /** The isolation-boundary adapter. The manager never executes anything itself. */
  readonly runtime: SandboxRuntime;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Optional audit sink - every lifecycle action is audited. */
  readonly auditSink?: SandboxAuditSink;
  /** Overrides the default profile (validated at construction). */
  readonly defaultProfile?: Partial<SandboxProfile>;
  /** Deterministic id generators for tests. */
  readonly generateSandboxId?: () => SandboxId;
  readonly generateExecutionId?: () => ExecutionId;
}

export interface CreateSandboxInput {
  /** Project Engine workspace id (opaque). Validated, never a host path. */
  readonly workspaceRef: string;
  readonly commandPolicy?: { allowedCommands: readonly string[]; allowShellExecution?: boolean };
  readonly networkPolicy?: SandboxProfile['networkPolicy'];
  readonly defaultLimits?: Partial<ResourceLimits>;
  readonly defaultEnvironment?: Readonly<Record<string, string>>;
  /** Time-to-live in milliseconds. Defaults to one hour. */
  readonly ttlMs?: number;
}

interface ExecutionState {
  readonly record: SandboxExecutionRecord;
  /** Set when cancellation was requested - wins over late completions. */
  cancelRequested: boolean;
  /** The in-flight runtime promise, if the execution is still pending. */
  pending: Promise<RuntimeExecutionOutcome> | null;
}

export class SandboxManager {
  private readonly runtime: SandboxRuntime;
  private readonly now: () => Date;
  private readonly auditSink?: SandboxAuditSink;
  private readonly generateSandboxId: () => SandboxId;
  private readonly generateExecutionId: () => ExecutionId;
  private readonly sandboxes = new Map<SandboxId, SandboxRecord>();
  private readonly executions = new Map<ExecutionId, ExecutionState>();
  /** sandboxId -> active executionId (one execution per sandbox at a time). */
  private readonly activeExecutions = new Map<SandboxId, ExecutionId>();
  private readonly defaultProfile: SandboxProfile;

  constructor(options: SandboxManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new InvalidSandboxRequestError('manager options are required');
    }
    if (!options.runtime || typeof options.runtime.execute !== 'function') {
      throw new InvalidSandboxRequestError(
        'a SandboxRuntime is required - the manager never executes commands itself',
      );
    }
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.auditSink = options.auditSink;
    this.generateSandboxId = options.generateSandboxId ?? (() => `sbx_${randomId()}`);
    this.generateExecutionId = options.generateExecutionId ?? (() => `exec_${randomId()}`);
    this.defaultProfile = buildProfile(options.defaultProfile);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates a sandbox. The profile is validated and then IMMUTABLE. */
  async createSandbox(input: CreateSandboxInput): Promise<SandboxRecord> {
    if (!input || typeof input !== 'object') {
      throw new InvalidSandboxRequestError('createSandbox input must be an object');
    }
    const workspaceRef = validateWorkspaceRef(input.workspaceRef);
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new InvalidSandboxRequestError(
        `ttlMs must be a positive integer up to ${MAX_TTL_MS}`,
        { reason: 'invalid-ttl' },
      );
    }
    const hasOverrides =
      input.commandPolicy !== undefined ||
      input.networkPolicy !== undefined ||
      input.defaultLimits !== undefined ||
      input.defaultEnvironment !== undefined;
    const profile: SandboxProfile = hasOverrides
      ? buildProfile(
          {
            ...(input.commandPolicy !== undefined ? { commandPolicy: input.commandPolicy } : {}),
            ...(input.networkPolicy !== undefined ? { networkPolicy: input.networkPolicy } : {}),
            ...(input.defaultLimits !== undefined ? { defaultLimits: input.defaultLimits } : {}),
            ...(input.defaultEnvironment !== undefined
              ? { defaultEnvironment: input.defaultEnvironment }
              : {}),
          },
          this.defaultProfile,
        )
      : this.defaultProfile;

    const now = this.now();
    const record: SandboxRecord = {
      id: this.generateSandboxId(),
      workspaceRef,
      status: 'creating',
      profile,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastExecutionId: null,
    };
    assertSandboxTransition('creating', 'ready');
    const ready: SandboxRecord = { ...record, status: 'ready', updatedAt: now.toISOString() };
    this.sandboxes.set(ready.id, ready);
    this.emit('sandbox_created', `sandbox "${ready.id}" created for workspace "${workspaceRef}"`, {
      sandboxId: ready.id,
      workspaceRef,
      runtimeId: this.runtime.runtimeId,
      osIsolation: this.runtime.providesOsIsolation,
      expiresAt: ready.expiresAt,
    });
    return ready;
  }

  /** Returns the sandbox record (lazily expiring it if past TTL). */
  async getSandbox(sandboxId: SandboxId): Promise<SandboxRecord> {
    const record = this.requireSandbox(sandboxId);
    return this.ensureFresh(record);
  }

  /** Lists sandbox summaries (lazily expired). */
  async listSandboxes(): Promise<readonly SandboxRecord[]> {
    const refreshed: SandboxRecord[] = [];
    for (const record of this.sandboxes.values()) {
      refreshed.push(await this.ensureFresh(record));
    }
    return refreshed;
  }

  /**
   * Stops a sandbox: running -> stopping -> stopped. Terminates any active
   * execution (its record becomes cancelled). A stopped sandbox cannot run
   * anything again; only destroy is allowed next.
   */
  async stopSandbox(sandboxId: SandboxId): Promise<SandboxRecord> {
    const current = await this.getSandbox(sandboxId);
    if (current.status === 'stopped' || current.status === 'destroyed') {
      return current;
    }
    await this.stopActiveExecution(sandboxId);
    const nowTs = this.now().toISOString();
    assertSandboxTransition(current.status, 'stopping');
    this.transition(sandboxId, 'stopping', nowTs);
    assertSandboxTransition('stopping', 'stopped');
    this.transition(sandboxId, 'stopped', nowTs);
    this.emit('sandbox_stopped', `sandbox "${sandboxId}" stopped`, { sandboxId });
    return this.requireSandbox(sandboxId);
  }

  /** Destroys a sandbox from any non-destroyed state. Terminal. */
  async destroySandbox(sandboxId: SandboxId): Promise<SandboxRecord> {
    const current = await this.getSandbox(sandboxId);
    if (current.status === 'destroyed') {
      return current;
    }
    await this.stopActiveExecution(sandboxId);
    const nowTs = this.now().toISOString();
    if (current.status !== 'stopping') {
      assertSandboxTransition(current.status, 'destroyed');
      this.transition(sandboxId, 'destroyed', nowTs);
    } else {
      this.transition(sandboxId, 'destroyed', nowTs);
    }
    await this.runtime.cleanup(sandboxId);
    this.emit('sandbox_destroyed', `sandbox "${sandboxId}" destroyed`, { sandboxId });
    return this.requireSandbox(sandboxId);
  }

  // ---------------------------------------------------------------- execution

  /**
   * Starts one execution. Validates everything, marks sandbox running, and
   * delegates to the runtime. The manager NEVER executes commands itself.
   */
  async startExecution(
    sandboxId: SandboxId,
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult> {
    const sandbox = await this.getSandbox(sandboxId);
    if (sandbox.status !== 'ready') {
      if (sandbox.status === 'expired') {
        throw new SandboxExpiredError(sandboxId, sandbox.expiresAt);
      }
      throw new SandboxNotReadyError(sandboxId, sandbox.status);
    }
    if (!isSandboxExecutable(sandbox.status)) {
      throw new SandboxNotReadyError(sandboxId, sandbox.status);
    }
    if (this.activeExecutions.has(sandboxId)) {
      throw new SandboxNotReadyError(sandboxId, 'running (an execution is already active)');
    }
    const executionId = this.generateExecutionId();
    const validated = this.validateExecutionRequest(sandbox, request);
    this.emit(
      'sandbox_execution_requested',
      `execution "${executionId}" requested on sandbox "${sandboxId}": ${validated.command}`,
      { sandboxId, executionId, command: validated.command, argumentCount: validated.arguments.length },
    );

    const startedAt = this.now().toISOString();
    const record: SandboxExecutionRecord = {
      id: executionId,
      sandboxId,
      command: validated.command,
      arguments: validated.arguments,
      status: 'running',
      startedAt,
      finishedAt: null,
      result: null,
    };
    const state: ExecutionState = { record, cancelRequested: false, pending: null };
    this.executions.set(executionId, state);
    this.activeExecutions.set(sandboxId, executionId);
    assertSandboxTransition(sandbox.status, 'running');
    this.transition(sandboxId, 'running', startedAt);
    const runningRecord = this.sandboxes.get(sandboxId);
    if (runningRecord) {
      this.sandboxes.set(sandboxId, { ...runningRecord, lastExecutionId: executionId });
    }
    this.emit(
      'sandbox_execution_started',
      `execution "${executionId}" started on sandbox "${sandboxId}" (runtime: ${this.runtime.runtimeId})`,
      { sandboxId, executionId, command: validated.command, runtimeId: this.runtime.runtimeId },
    );

    const runtimeRequest: RuntimeExecutionRequest = {
      executionId,
      sandboxId,
      workspaceRef: sandbox.workspaceRef,
      command: validated.command,
      arguments: validated.arguments,
      workingDirectory: validated.workingDirectory,
      environment: validated.environment,
      limits: validated.limits,
      networkPolicy: sandbox.profile.networkPolicy,
    };
    const pending = this.runtime.execute(runtimeRequest);
    state.pending = pending;

    let outcome: RuntimeExecutionOutcome;
    try {
      outcome = await pending;
    } catch (error) {
      // The runtime itself failed - the execution result must still be safe.
      outcome = {
        exitCode: null,
        stdout: '',
        stderr: isSandboxError(error) ? error.message : 'the sandbox runtime failed',
        timedOut: false,
        terminated: false,
        terminationReason: null,
        truncated: false,
        resourceUsage: zeroUsage(),
        enforcement: UNAVAILABLE_ENFORCEMENT,
      };
      this.finalizeExecution(executionId, 'failed', outcome, sandbox);
      this.emit('sandbox_execution_failed', `execution "${executionId}" failed in the runtime`, {
        sandboxId,
        executionId,
        command: validated.command,
      });
      const failed = this.executions.get(executionId);
      this.releaseSandboxAfterExecution(sandboxId, 'failed');
      const result = failed?.record.result;
      if (!result) {
        throw new SandboxNotFoundError(sandboxId);
      }
      return result;
    }

    // Cancellation wins over late completion (race protection).
    const cancelled = state.cancelRequested || outcome.terminationReason === 'cancelled';
    const status: ExecutionStatus = cancelled
      ? 'cancelled'
      : outcome.timedOut
        ? 'timed_out'
        : outcome.terminated
          ? 'terminated'
          : outcome.exitCode === 0
            ? 'completed'
            : 'failed';
    const result = this.finalizeExecution(executionId, status, outcome, sandbox);
    const auditType =
      status === 'cancelled'
        ? 'sandbox_execution_cancelled'
        : status === 'timed_out'
          ? 'sandbox_execution_timed_out'
          : status === 'terminated'
            ? 'sandbox_execution_terminated'
            : status === 'failed'
              ? 'sandbox_execution_failed'
              : 'sandbox_execution_completed';
    this.emit(
      auditType,
      `execution "${executionId}" ${status.replace('_', ' ')} on sandbox "${sandboxId}"`,
      {
        sandboxId,
        executionId,
        command: validated.command,
        exitCode: outcome.exitCode,
        durationMs: result.resourceUsage.durationMs,
        truncated: result.truncated,
      },
    );
    this.releaseSandboxAfterExecution(sandboxId, status);
    return result;
  }

  /** Returns one execution record. Terminal records never resume. */
  async getExecution(sandboxId: SandboxId, executionId: ExecutionId): Promise<SandboxExecutionRecord> {
    await this.getSandbox(sandboxId);
    const state = this.executions.get(executionId);
    if (!state || state.record.sandboxId !== sandboxId) {
      throw new ExecutionNotFoundError(executionId);
    }
    return state.record;
  }

  /**
   * Cancels a running execution: running -> stopping -> cancelled (terminal).
   * A cancelled execution can never resume or be re-submitted; a new
   * execution needs a fresh startExecution call.
   */
  async cancelExecution(sandboxId: SandboxId, executionId: ExecutionId): Promise<SandboxExecutionRecord> {
    await this.getSandbox(sandboxId);
    const state = this.executions.get(executionId);
    if (!state || state.record.sandboxId !== sandboxId) {
      throw new ExecutionNotFoundError(executionId);
    }
    if (state.record.status !== 'running' && state.record.status !== 'stopping') {
      // Terminal executions cannot be cancelled again (idempotence guard
      // throws so callers learn the execution already ended).
      throw new SandboxNotReadyError(executionId, `execution is already ${state.record.status}`);
    }
    state.cancelRequested = true;
    assertExecutionTransition(state.record.status, 'stopping');
    this.setExecutionStatus(executionId, 'stopping');
    await this.runtime.terminate(executionId);
    if (state.pending) {
      // Wait for the runtime's cancellation to settle; the startExecution
      // path performs the final terminal mapping.
      await state.pending.catch(() => undefined);
    }
    const settled = this.executions.get(executionId);
    if (!settled) {
      throw new ExecutionNotFoundError(executionId);
    }
    if (settled.record.status === 'cancelled' || settled.record.status === 'stopping') {
      // Defensive: resolve stopping -> cancelled even if the runtime never
      // reported back (a real runtime must always settle; this keeps the
      // record honest rather than hanging).
      if (settled.record.status === 'stopping') {
        this.setExecutionStatus(executionId, 'cancelled');
      }
      this.emit(
        'sandbox_execution_cancelled',
        `execution "${executionId}" cancelled on sandbox "${sandboxId}"`,
        { sandboxId, executionId },
      );
    }
    return this.requireExecution(executionId);
  }

  // ---------------------------------------------------------------- internals

  private validateExecutionRequest(sandbox: SandboxRecord, request: SandboxExecutionRequest): {
    command: string;
    arguments: string[];
    workingDirectory: string;
    environment: Readonly<Record<string, string>>;
    limits: ResourceLimits;
  } {
    if (!request || typeof request !== 'object') {
      throw new InvalidSandboxRequestError('execution request must be an object');
    }
    const command = assertCommandAllowedRaw(sandbox, request.command);
    const args = validateArguments(request.arguments ?? []);
    const workingDirectory = normalizeWorkspaceRelativePath(
      request.workingDirectory ?? '',
      'workingDirectory',
    );
    const environment = buildIsolatedEnvironment(
      sandbox.profile.defaultEnvironment,
      request.environment,
    );
    const limits = resolveExecutionLimits(sandbox.profile.defaultLimits, request.limits);
    assertExecutionNetworkPolicy(sandbox.profile.networkPolicy);
    return { command, arguments: args, workingDirectory, environment, limits };
  }

  /** Applies the terminal status, output bounding + scrubbing, timestamps. */
  private finalizeExecution(
    executionId: ExecutionId,
    status: ExecutionStatus,
    outcome: RuntimeExecutionOutcome,
    sandbox: SandboxRecord,
  ): SandboxExecutionResult {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new ExecutionNotFoundError(executionId);
    }
    assertExecutionTransition(state.record.status, status);
    const finishedAt = this.now().toISOString();
    const limits = this.resolveRecordedLimits(sandbox);
    const stdout = sanitizeOutput(outcome.stdout, limits);
    const stderr = sanitizeOutput(outcome.stderr, limits);
    const scrubbedCount = stdout.scrubbedCount + stderr.scrubbedCount;
    const truncated = outcome.truncated || stdout.truncated || stderr.truncated;
    const result: SandboxExecutionResult = {
      executionId,
      sandboxId: sandbox.id,
      status,
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: outcome.timedOut,
      terminated: outcome.terminated,
      terminationReason: outcome.terminationReason,
      truncated,
      resourceUsage: normalizeUsage(outcome.resourceUsage),
      enforcement: outcome.enforcement,
      startedAt: state.record.startedAt,
      finishedAt,
      scrubbedCount,
    };
    const finalized: SandboxExecutionRecord = {
      ...state.record,
      status,
      finishedAt,
      result,
    };
    this.executions.set(executionId, { ...state, record: finalized, pending: null });
    return result;
  }

  /** Limits recorded at execution time (defaults - overrides are bounded by the same ceilings). */
  private resolveRecordedLimits(sandbox: SandboxRecord): ResourceLimits {
    return resolveExecutionLimits(sandbox.profile.defaultLimits, undefined);
  }

  private releaseSandboxAfterExecution(sandboxId: SandboxId, status: ExecutionStatus): void {
    this.activeExecutions.delete(sandboxId);
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    const nowTs = this.now().toISOString();
    if (sandbox.status === 'running') {
      if (status === 'failed' && sandbox.status === 'running') {
        // A failed execution returns the sandbox to ready - the sandbox
        // itself did not fail; the command did. Honest and simple.
      }
      assertSandboxTransition('running', 'ready');
      this.transition(sandboxId, 'ready', nowTs);
    }
    // stopping / expired / destroyed sandboxes stay as they are - the
    // stop/expire/destroy paths own their transitions.
  }

  /** Lazily expires sandboxes past their TTL (no production scheduler yet). */
  private async ensureFresh(record: SandboxRecord): Promise<SandboxRecord> {
    if (
      record.status === 'destroyed' ||
      record.status === 'stopped' ||
      record.status === 'failed' ||
      record.status === 'expired'
    ) {
      return record;
    }
    if (this.now().getTime() < Date.parse(record.expiresAt)) {
      return record;
    }
    await this.stopActiveExecution(record.id);
    const nowTs = this.now().toISOString();
    if (record.status === 'stopping') {
      this.transition(record.id, 'expired', nowTs);
    } else {
      assertSandboxTransition(record.status, 'expired');
      this.transition(record.id, 'expired', nowTs);
    }
    this.emit('sandbox_expired', `sandbox "${record.id}" expired`, {
      sandboxId: record.id,
      expiresAt: record.expiresAt,
    });
    return this.requireSandbox(record.id);
  }

  /** Stops the active execution of a sandbox (stop/expire/destroy paths). */
  private async stopActiveExecution(sandboxId: SandboxId): Promise<void> {
    const executionId = this.activeExecutions.get(sandboxId);
    if (!executionId) return;
    const state = this.executions.get(executionId);
    if (state && (state.record.status === 'running' || state.record.status === 'stopping')) {
      state.cancelRequested = true;
      if (state.record.status === 'running') {
        assertExecutionTransition('running', 'stopping');
        this.setExecutionStatus(executionId, 'stopping');
      }
      await this.runtime.terminate(executionId);
      if (state.pending) {
        await state.pending.catch(() => undefined);
      }
      const settled = this.executions.get(executionId);
      if (settled && settled.record.status === 'stopping') {
        this.setExecutionStatus(executionId, 'cancelled');
      }
      this.emit(
        'sandbox_execution_cancelled',
        `execution "${executionId}" cancelled (sandbox "${sandboxId}" is being stopped/expired/destroyed)`,
        { sandboxId, executionId },
      );
    }
    this.activeExecutions.delete(sandboxId);
  }

  private requireSandbox(sandboxId: SandboxId): SandboxRecord {
    const record = this.sandboxes.get(sandboxId);
    if (!record) {
      throw new SandboxNotFoundError(sandboxId);
    }
    return record;
  }

  private requireExecution(executionId: ExecutionId): SandboxExecutionRecord {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new ExecutionNotFoundError(executionId);
    }
    return state.record;
  }

  private transition(sandboxId: SandboxId, to: SandboxStatus, timestamp: string): void {
    const record = this.requireSandbox(sandboxId);
    const next: SandboxRecord = { ...record, status: to, updatedAt: timestamp };
    this.sandboxes.set(sandboxId, next);
  }

  private setExecutionStatus(executionId: ExecutionId, status: ExecutionStatus): void {
    const state = this.executions.get(executionId);
    if (!state) {
      throw new ExecutionNotFoundError(executionId);
    }
    this.executions.set(executionId, { ...state, record: { ...state.record, status } });
  }

  private emit(
    type: SandboxAuditEventType,
    summary: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.auditSink) return;
    this.auditSink(createSandboxAuditEvent({ type, summary, metadata, timestamp: this.now().toISOString() }));
  }
}

function assertCommandAllowedRaw(sandbox: SandboxRecord, command: string): string {
  assertCommandAllowed(command, sandbox.profile.commandPolicy);
  return command;
}

function normalizeUsage(usage: RuntimeExecutionOutcome['resourceUsage']): RuntimeExecutionOutcome['resourceUsage'] {
  const n = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    cpuTimeMs: n(usage?.cpuTimeMs),
    memoryPeakMb: n(usage?.memoryPeakMb),
    outputBytes: n(usage?.outputBytes),
    durationMs: n(usage?.durationMs),
    processCount: n(usage?.processCount),
    fileBytesWritten: n(usage?.fileBytesWritten),
  };
}

function zeroUsage(): RuntimeExecutionOutcome['resourceUsage'] {
  return {
    cpuTimeMs: 0,
    memoryPeakMb: 0,
    outputBytes: 0,
    durationMs: 0,
    processCount: 0,
    fileBytesWritten: 0,
  };
}

/** Honest enforcement report for runtime-level failures. */
const UNAVAILABLE_ENFORCEMENT: RuntimeExecutionOutcome['enforcement'] = Object.freeze({
  timeoutMs: 'unavailable',
  maxMemoryMb: 'unavailable',
  maxCpuTimeMs: 'unavailable',
  maxOutputBytes: 'unavailable',
  maxProcesses: 'unavailable',
  maxFileBytes: 'unavailable',
});

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/** Loose creation-time profile input (every part validated before use). */
type ProfileInput = {
  commandPolicy?: { allowedCommands: readonly string[]; allowShellExecution?: boolean };
  networkPolicy?: SandboxProfile['networkPolicy'];
  defaultLimits?: Partial<ResourceLimits>;
  defaultEnvironment?: Readonly<Record<string, string>>;
};

/** Builds and validates a complete sandbox profile from partial input. */
function buildProfile(
  input: ProfileInput | undefined,
  base?: SandboxProfile,
): SandboxProfile {
  const source = input ?? {};
  const commandPolicy =
    source.commandPolicy !== undefined
      ? validateCommandPolicy({
          allowedCommands: source.commandPolicy.allowedCommands,
          allowShellExecution: source.commandPolicy.allowShellExecution ?? false,
        })
      : base
        ? base.commandPolicy
        : { allowedCommands: [...DEFAULT_ALLOWED_COMMANDS], allowShellExecution: false };
  const networkPolicy =
    source.networkPolicy !== undefined
      ? validateNetworkPolicy(source.networkPolicy)
      : base
        ? base.networkPolicy
        : { mode: 'disabled' as const, allowedDestinations: [] };
  const defaultLimits =
    source.defaultLimits !== undefined
      ? validateResourceLimits(source.defaultLimits, 'defaultLimits')
      : base
        ? base.defaultLimits
        : { ...DEFAULT_RESOURCE_LIMITS };
  const defaultEnvironment =
    source.defaultEnvironment !== undefined
      ? validateDefaultEnvironment(source.defaultEnvironment)
      : base
        ? base.defaultEnvironment
        : {};
  return { commandPolicy, networkPolicy, defaultLimits, defaultEnvironment };
}

// Profile-entry validators: static imports, ESM-safe.

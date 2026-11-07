/**
 * The verification runner - Step 45.
 *
 * One run: read the revision's files, detect what can be verified, resolve the
 * permitted operations to exact commands, execute them through the sandbox one
 * at a time, and record what actually happened. Nothing is executed in this
 * process and no shell string is ever constructed.
 */

import { detectVerificationProfile } from './discovery.js';
import { interpretOutcome } from './parsers.js';
import { planVerification } from './policy.js';
import { boundedTail, scrubSecrets } from './sanitize.js';
import type {
  OperationResult,
  ProjectFileSource,
  RawExecution,
  RunStatus,
  VerificationEvidence,
  VerificationExecutor,
  VerificationLimits,
  VerificationOperation,
  VerificationRunRecord,
  VerificationSession,
  VerificationStore,
  OperationStatus,
} from './types.js';
import { DEFAULT_VERIFICATION_LIMITS, HARD_VERIFICATION_CEILINGS } from './types.js';

export interface VerificationRunnerOptions {
  readonly executor: VerificationExecutor;
  readonly files: ProjectFileSource;
  readonly store: VerificationStore;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly limits?: Partial<VerificationLimits>;
}

export interface RunVerificationInput {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly workerId?: string | null;
  readonly operations: readonly string[];
  /** Operations a worker's assignment authorizes; null for a direct caller. */
  readonly authorized?: readonly VerificationOperation[] | null;
  readonly path?: string | null;
  readonly revision?: string | null;
  readonly limits?: Partial<VerificationLimits>;
  /** 0 for the first run, higher for a repair attempt. */
  readonly attempt?: number;
  readonly repairsRunId?: string | null;
}

const MAX_FILES = 600;
const MAX_FILE_BYTES = 200_000;

function clampLimits(
  base: VerificationLimits,
  overrides: Partial<VerificationLimits> | undefined,
): VerificationLimits {
  const pick = (value: number | undefined, fallback: number, ceiling: number): number =>
    value === undefined || !Number.isFinite(value)
      ? fallback
      : Math.max(1, Math.min(Math.floor(value), ceiling));
  return {
    maxOperations: pick(
      overrides?.maxOperations,
      base.maxOperations,
      HARD_VERIFICATION_CEILINGS.maxOperations,
    ),
    timeoutMsPerOperation: pick(
      overrides?.timeoutMsPerOperation,
      base.timeoutMsPerOperation,
      HARD_VERIFICATION_CEILINGS.timeoutMsPerOperation,
    ),
    maxOutputBytes: pick(
      overrides?.maxOutputBytes,
      base.maxOutputBytes,
      HARD_VERIFICATION_CEILINGS.maxOutputBytes,
    ),
    maxRepairAttempts: pick(
      overrides?.maxRepairAttempts,
      base.maxRepairAttempts,
      HARD_VERIFICATION_CEILINGS.maxRepairAttempts,
    ),
  };
}

export class VerificationRunner {
  readonly #options: VerificationRunnerOptions;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #cancelled = new Set<string>();
  readonly #sessions = new Map<string, VerificationSession>();

  constructor(options: VerificationRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  }

  /**
   * Cancels a run. In-flight commands are terminated through the executor when
   * it supports it; the record is finalised by the run itself, so a cancelled
   * run still reports what had already been learned.
   */
  async cancel(ownerRef: string, runId: string): Promise<VerificationRunRecord | null> {
    const existing = await this.#options.store.get(ownerRef, runId);
    if (existing === null) return null;
    if (existing.status !== 'running') return existing;
    this.#cancelled.add(runId);
    this.#cancelWaiters.get(runId)?.();
    const session = this.#sessions.get(runId);
    if (session !== undefined && this.#options.executor.terminate !== undefined) {
      await this.#options.executor.terminate(session).catch(() => undefined);
    }
    return existing;
  }

  async run(input: RunVerificationInput): Promise<VerificationRunRecord> {
    const limits = clampLimits(
      { ...DEFAULT_VERIFICATION_LIMITS, ...this.#options.limits },
      input.limits,
    );
    const startedAt = this.#now().toISOString();
    const runId = this.#newId();

    const reading = await this.#options.files.read({
      projectId: input.projectId,
      revision: input.revision ?? null,
    });
    const files = reading.files
      .slice(0, MAX_FILES)
      .map((entry) => ({ path: entry.path, content: entry.content.slice(0, MAX_FILE_BYTES) }));
    const profile = detectVerificationProfile(files);
    const plan = planVerification({
      profile,
      requested: input.operations,
      authorized: input.authorized ?? null,
      limits,
      path: input.path ?? undefined,
    });

    const base: VerificationRunRecord = {
      id: runId,
      ownerRef: input.ownerRef,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workerId: input.workerId ?? null,
      revision: reading.revision,
      status: 'running',
      requestedOperations: input.operations as VerificationOperation[],
      blocked: plan.blocked,
      results: [],
      evidence: null,
      repairsRunId: input.repairsRunId ?? null,
      attempt: input.attempt ?? 0,
      startedAt,
      finishedAt: null,
      limits,
      version: 0,
    };
    await this.#options.store.save(base);

    const results: OperationResult[] = [];
    let session: VerificationSession | null = null;
    let cancelled = false;
    let prepareFailure: string | null = null;

    if (plan.commands.length > 0) {
      try {
        session = await this.#options.executor.prepare({
          projectId: input.projectId,
          revision: reading.revision,
          files,
          limits,
          commandPolicy: {
            allowedCommands: [...new Set(plan.commands.map((command) => command.command))],
          },
        });
        this.#sessions.set(runId, session);
      } catch (error) {
        prepareFailure = error instanceof Error ? error.message : 'The sandbox could not start.';
      }
    }

    try {
      for (const command of plan.commands) {
        if (prepareFailure !== null || session === null) {
          results.push(
            this.#blockedResult(command.operation, command.id, command.label, [...command.args], {
              startedAt: this.#now().toISOString(),
              reason: prepareFailure ?? 'The sandbox is unavailable.',
            }),
          );
          continue;
        }
        if (this.#cancelled.has(runId)) {
          cancelled = true;
          results.push(
            this.#blockedResult(command.operation, command.id, command.label, [...command.args], {
              startedAt: this.#now().toISOString(),
              reason: 'The run was cancelled before this operation started.',
              status: 'cancelled',
            }),
          );
          continue;
        }

        const operationStarted = this.#now();
        const raw = await this.#executeWithCancellation(runId, session, command, limits);
        if (this.#cancelled.has(runId)) cancelled = true;
        results.push(this.#toResult(command, operationStarted, raw, limits));
      }
    } finally {
      if (session !== null) {
        await session.dispose().catch(() => undefined);
        this.#sessions.delete(runId);
      }
    }

    const finishedAt = this.#now().toISOString();
    const executed = results.filter((result) => result.runtimeId !== null);
    const status = this.#runStatus({ cancelled, executed, blocked: plan.blocked, results });
    const evidence: VerificationEvidence = {
      kind: 'verification-run',
      runId,
      projectId: input.projectId,
      revision: reading.revision,
      operations: plan.commands.map((command) => command.operation),
      status,
      executed: executed.length > 0,
      executedCount: executed.length,
      passedCount: results.filter((result) => result.status === 'passed').length,
      failedCount: results.filter(
        (result) => result.status === 'failed' || result.status === 'timed_out',
      ).length,
      finishedAt,
    };

    const record: VerificationRunRecord = {
      ...base,
      status,
      results,
      evidence,
      finishedAt,
      version: base.version + 1,
    };
    await this.#options.store.save(record);
    this.#cancelled.delete(runId);
    return record;
  }

  async #executeWithCancellation(
    runId: string,
    session: VerificationSession,
    command: { command: string; args: readonly string[] },
    limits: VerificationLimits,
  ): Promise<RawExecution> {
    let stop: (() => void) | null = null;
    const stopped = new Promise<'cancelled'>((resolve) => {
      stop = () => resolve('cancelled');
    });
    this.#cancelWaiters.set(runId, () => stop?.());
    try {
      const outcome = await Promise.race([
        this.#options.executor.execute(
          session,
          { command: command.command, args: command.args },
          { timeoutMs: limits.timeoutMsPerOperation, maxOutputBytes: limits.maxOutputBytes },
        ),
        stopped,
      ]);
      if (outcome === 'cancelled') {
        return {
          exitCode: null,
          stdout: '',
          stderr: 'The run was cancelled.',
          timedOut: false,
          truncated: false,
          durationMs: 0,
          enforceableTimeout: true,
          runtimeId: session.runtimeId,
          providesOsIsolation: session.providesOsIsolation,
          unenforced: session.unenforced,
        };
      }
      return outcome;
    } finally {
      this.#cancelWaiters.delete(runId);
    }
  }

  readonly #cancelWaiters = new Map<string, () => void>();

  #toResult(
    command: {
      operation: VerificationOperation;
      id: string;
      label: string;
      command: string;
      args: readonly string[];
    },
    startedAt: Date,
    raw: RawExecution,
    limits: VerificationLimits,
  ): OperationResult {
    const combined = `${raw.stdout}\n${raw.stderr}`;
    const scrubbed = scrubSecrets(combined);
    const tail = boundedTail(scrubbed.text, limits.maxOutputBytes);
    const interpreted = interpretOutcome({
      operation: command.operation,
      exitCode: raw.exitCode,
      stdout: scrubSecrets(raw.stdout).text,
      stderr: scrubSecrets(raw.stderr).text,
      timedOut: raw.timedOut,
      truncated: raw.truncated || tail.truncated,
    });
    const cancelledResult =
      scrubbed.text.includes('The run was cancelled.') && raw.exitCode === null;
    const status: OperationStatus = cancelledResult ? 'cancelled' : interpreted.status;
    return {
      operation: command.operation,
      commandId: command.id,
      label: command.label,
      argv: [command.command, ...command.args],
      status,
      exitCode: raw.exitCode,
      startedAt: startedAt.toISOString(),
      finishedAt: this.#now().toISOString(),
      durationMs: raw.durationMs,
      counts: interpreted.counts,
      buildStatus: interpreted.buildStatus,
      errorSummary: interpreted.errorSummary,
      outputTail: tail.text,
      outputBytes: Buffer.byteLength(combined, 'utf8'),
      truncated: raw.truncated || tail.truncated,
      reason:
        status === 'cancelled' ? 'The run was cancelled while this command was running.' : null,
      runtimeId: raw.runtimeId,
      providesOsIsolation: raw.providesOsIsolation,
      unenforced: raw.unenforced,
    };
  }

  #blockedResult(
    operation: VerificationOperation,
    commandId: string,
    label: string,
    argv: readonly string[],
    input: { startedAt: string; reason: string; status?: OperationStatus },
  ): OperationResult {
    return {
      operation,
      commandId,
      label,
      argv,
      status: input.status ?? 'blocked',
      exitCode: null,
      startedAt: input.startedAt,
      finishedAt: input.startedAt,
      durationMs: 0,
      counts: { discovered: null, passed: null, failed: null, skipped: null },
      buildStatus: 'unknown',
      errorSummary: input.reason,
      outputTail: '',
      outputBytes: 0,
      truncated: false,
      reason: input.reason,
      runtimeId: null,
      providesOsIsolation: false,
      unenforced: [],
    };
  }

  #runStatus(input: {
    cancelled: boolean;
    executed: readonly OperationResult[];
    blocked: readonly { operation: VerificationOperation }[];
    results: readonly OperationResult[];
  }): RunStatus {
    if (input.cancelled) return 'cancelled';
    if (input.results.some((result) => result.status === 'timed_out')) return 'timed_out';
    if (input.executed.length === 0) return input.blocked.length > 0 ? 'blocked' : 'incomplete';
    const failed = input.results.some(
      (result) => result.status === 'failed' || result.status === 'timed_out',
    );
    if (failed) return 'failed';
    // Some operations were asked for and never ran: nothing failed, but the
    // project is not verified either, so the run says so instead of "passed".
    const notRun = input.results.filter((result) => result.runtimeId === null).length;
    if (notRun > 0 || input.blocked.length > 0) return 'incomplete';
    return 'passed';
  }
}

/**
 * CodingAgentManager: creates, drives, inspects, cancels, and resumes Coding
 * Agent runs. Every project mutation and every validation flows through the
 * Tool System; this manager never touches the host filesystem, a shell, the
 * environment, credentials, or a provider SDK.
 *
 * The run loop is BOUNDED: iterations, tool calls, duration, and consecutive
 * failures all have server-side limits with hard ceilings. Model output and
 * user requests can never raise them.
 */

import type { ToolInvocationResult, ToolManager } from '@veltravia/tool-core';

import { createCodingAuditEmitter, type CodingAuditSink } from '../audit/index.js';
import { CodingError, scrubCodingSecrets } from '../errors/index.js';
import { validateCodingDecision } from '../decisions/index.js';
import {
  bindCodingAction,
  CODING_TOOL_IDS,
  resolveCodingLimits,
  validateCodingRunRequest,
} from '../policy/index.js';
import { transition } from '../state/index.js';
import {
  isCodingRunTerminal,
  type CodingDecisionContext,
  type CodingDecisionSource,
  type CodingPendingApproval,
  type CodingPlan,
  type CodingRunLimits,
  type CodingRunRequest,
  type CodingRunState,
  type CodingRunView,
  type CodingToolResultView,
  type CodingValidationResult,
} from '../types/index.js';

const MAX_UNTRUSTED_CONTEXT_ITEMS = 10;

interface ManagedRun {
  readonly request: CodingRunRequest;
  readonly limits: CodingRunLimits;
  readonly startedAt: Date;
  state: CodingRunState;
  plan: CodingPlan | null;
  planApproved: boolean;
  summary: string | null;
  changedFiles: Map<string, 'created' | 'updated' | 'moved' | 'deleted'>;
  workspaceRevision: number | null;
  sandboxId: string | null;
  iterations: number;
  toolCalls: number;
  consecutiveFailures: number;
  cancelled: boolean;
  pendingApproval: CodingPendingApproval | null;
  resumeState: CodingRunState | null;
  untrustedFiles: { path: string; content: string }[];
  /** The most recent failed tool invocation, for precise failure causes. */
  lastFailure: { toolId: string; errorCode: string } | null;
  /** The latest node revision per file this run has read/created/updated. */
  fileRevisions: Map<string, number>;
  untrustedToolResults: CodingToolResultView[];
  validationResults: CodingValidationResult[];
  failure: { code: string; message: string } | null;
  updatedAt: Date;
}

export interface CodingAgentManagerOptions {
  /** The Tool System - the ONLY path to project files and the sandbox. */
  readonly tools: ToolManager;
  /** Provider-neutral decision source (scripted mock in tests; AI-routed later). */
  readonly decisionSource: CodingDecisionSource;
  readonly now?: () => Date;
  readonly generateRunId?: () => string;
  readonly onAudit?: CodingAuditSink;
  /** Trusted server-side config: whether plans need human approval. Default: true. */
  readonly requirePlanApproval?: boolean;
  /** Trusted server-side limit overrides (still capped by hard ceilings). */
  readonly limits?: Partial<CodingRunLimits>;
}

/** Loop signal: `null` = keep driving, otherwise the run stops with this view. */
type DriveOutcome = CodingRunView | null;

export class CodingAgentManager {
  private readonly tools: ToolManager;
  private readonly decisionSource: CodingDecisionSource;
  private readonly now: () => Date;
  private readonly generateRunId: () => string;
  private readonly requirePlanApproval: boolean;
  private readonly limitOverrides: Partial<CodingRunLimits>;
  private readonly runs = new Map<string, ManagedRun>();

  constructor(options: CodingAgentManagerOptions) {
    this.tools = options.tools;
    this.decisionSource = options.decisionSource;
    this.now = options.now ?? (() => new Date());
    this.generateRunId =
      options.generateRunId ?? (() => `run_${Math.random().toString(36).slice(2, 12)}`);
    this.requirePlanApproval = options.requirePlanApproval ?? true;
    this.limitOverrides = options.limits ?? {};
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Creates and drives a run to completion, failure, or a pending approval. */
  async startRun(
    request: Omit<CodingRunRequest, 'runId'> & { runId?: string },
  ): Promise<CodingRunView> {
    const runId = request.runId ?? this.generateRunId();
    const full: CodingRunRequest = { ...request, runId };
    validateCodingRunRequest(full);
    if (this.runs.has(runId)) {
      throw new CodingError('CODING_INVALID_REQUEST', `run "${runId}" already exists`, {
        details: { runId },
      });
    }
    const run: ManagedRun = {
      request: full,
      limits: resolveCodingLimits(this.limitOverrides),
      startedAt: this.now(),
      state: 'idle',
      plan: null,
      planApproved: false,
      summary: null,
      changedFiles: new Map(),
      workspaceRevision: null,
      sandboxId: null,
      iterations: 0,
      toolCalls: 0,
      consecutiveFailures: 0,
      cancelled: false,
      pendingApproval: null,
      resumeState: null,
      untrustedFiles: [],
      fileRevisions: new Map(),
      lastFailure: null,
      untrustedToolResults: [],
      validationResults: [],
      failure: null,
      updatedAt: this.now(),
    };
    this.runs.set(runId, run);
    const audit = createCodingAuditEmitter(runId, this.now);
    run.state = transition(run.state, 'analyzing');
    audit('coding_run_started', `Coding run started for project "${full.projectId}"`, {
      projectId: full.projectId,
      workspaceId: full.workspaceId,
      limits: run.limits,
    });
    return this.drive(run);
  }

  /** Safe view of one run. Never exposes secrets or chain-of-thought. */
  getRun(runId: string): CodingRunView {
    return this.view(this.run(runId));
  }

  private run(runId: string): ManagedRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new CodingError('CODING_RUN_NOT_FOUND', `no coding run "${runId}"`, {
        details: { runId },
      });
    }
    return run;
  }

  /** One-way, terminal, race-safe cancellation. Committed mutations are kept. */
  cancelRun(runId: string): CodingRunView {
    const run = this.run(runId);
    if (isCodingRunTerminal(run.state)) {
      throw new CodingError('CODING_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        details: { runId, state: run.state },
      });
    }
    run.cancelled = true;
    const audit = createCodingAuditEmitter(runId, this.now);
    if (run.state === 'awaiting_approval') {
      // Paused runs cancel immediately; no further execution is possible.
      run.pendingApproval = null;
      run.resumeState = null;
      run.state = transition(run.state, 'cancelled');
      run.updatedAt = this.now();
      audit('coding_run_cancelled', 'Coding run cancelled while awaiting approval', {
        committedFiles: [...run.changedFiles.keys()],
      });
      return this.view(run);
    }
    // Active runs cancel at the next loop check (race-safe).
    run.updatedAt = this.now();
    audit('coding_run_cancelled', 'Coding run cancellation requested', {});
    return this.view(run);
  }

  /** Submits a human approval decision for a paused run (plan or confirmation). */
  async submitApproval(runId: string, decision: 'approve' | 'reject'): Promise<CodingRunView> {
    const run = this.run(runId);
    if (isCodingRunTerminal(run.state)) {
      throw new CodingError('CODING_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        details: { runId, state: run.state },
      });
    }
    if (run.state !== 'awaiting_approval' || run.pendingApproval === null) {
      throw new CodingError(
        'CODING_NOT_AWAITING_APPROVAL',
        `run "${runId}" has no pending approval`,
        {
          details: { runId, state: run.state },
        },
      );
    }
    const pending = run.pendingApproval;
    const audit = createCodingAuditEmitter(runId, this.now);

    if (pending.kind === 'plan_approval') {
      run.pendingApproval = null;
      run.resumeState = null;
      if (decision === 'reject') {
        audit('coding_plan_rejected', 'Coding plan rejected by human', {});
        return this.finishFailure(run, 'CODING_PLAN_REJECTED', 'plan rejected by human');
      }
      run.planApproved = true;
      audit('coding_plan_approved', 'Coding plan approved by human', {});
      run.state = transition(run.state, 'inspecting');
      run.updatedAt = this.now();
      return this.drive(run);
    }

    // Tool confirmation: the Step 5 mechanism is the single authority.
    this.tools.confirm(pending.confirmationId, decision === 'approve' ? 'approved' : 'rejected');
    const resumeState = run.resumeState ?? 'inspecting';
    const resumeInput: Record<string, unknown> = this.resumeInputs.get(runId) ?? {};
    run.pendingApproval = null;
    run.resumeState = null;
    this.resumeInputs.delete(runId);
    run.state = transition(run.state, resumeState);
    run.updatedAt = this.now();
    if (decision === 'reject') {
      this.recordToolDenial(
        run,
        pending.toolId,
        'TOOL_CONFIRMATION_REJECTED',
        'human rejected the confirmation',
      );
      if (run.consecutiveFailures >= run.limits.maxConsecutiveFailures) {
        return this.finishFailure(
          run,
          'CODING_CONSECUTIVE_FAILURES',
          'consecutive failure limit reached',
        );
      }
      return this.drive(run);
    }
    const outcome = await this.invokeTool(run, pending.toolId, resumeInput, pending.confirmationId);
    if (outcome === null) {
      return this.view(run); // paused again for another confirmation
    }
    if (run.state === 'failed' || run.cancelled) {
      return this.view(run);
    }
    const processed = await this.processToolOutcome(run, pending.toolId, resumeInput, outcome);
    if (processed !== null) {
      return processed;
    }
    return this.drive(run);
  }

  // ---- run loop ---------------------------------------------------------------

  private async drive(run: ManagedRun): Promise<CodingRunView> {
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    while (!isCodingRunTerminal(run.state)) {
      if (run.cancelled) {
        run.state = transition(run.state, 'cancelled');
        run.updatedAt = this.now();
        audit('coding_run_cancelled', 'Coding run cancelled; committed changes preserved', {
          committedFiles: [...run.changedFiles.keys()],
        });
        return this.view(run);
      }
      this.assertDuration(run);
      if (run.state === 'failed') {
        return this.view(run);
      }
      let decision: ReturnType<typeof validateCodingDecision>;
      try {
        decision = validateCodingDecision(
          await this.decisionSource.nextDecision(this.buildContext(run)),
        );
      } catch (error) {
        // Malformed/untrusted decision output NEVER acts; the run fails typed.
        const message = error instanceof CodingError ? error.message : 'invalid decision';
        const code = error instanceof CodingError ? error.code : 'CODING_INVALID_DECISION';
        return this.finishFailure(run, code, message);
      }
      if (run.cancelled) {
        continue; // cancellation landed mid-decision; loop head handles it
      }
      switch (decision.type) {
        case 'plan':
          try {
            const stop = this.handlePlanDecision(run, decision.plan);
            if (stop !== null) return stop;
          } catch (error) {
            const message = error instanceof CodingError ? error.message : 'plan rejected';
            const code = error instanceof CodingError ? error.code : 'CODING_INVALID_PLAN';
            return this.finishFailure(run, code, message);
          }
          break;
        case 'action': {
          try {
            const stop = await this.handleAction(run, decision.action);
            if (stop !== null) return stop;
          } catch (error) {
            if (error instanceof CodingError) {
              return this.finishFailure(run, error.code, error.message);
            }
            return this.finishFailure(
              run,
              'CODING_INVALID_DECISION',
              (error as Error).message ?? 'action failed',
            );
          }
          break;
        }
        case 'complete':
          return this.finishCompletion(run, decision.summary);
        case 'fail':
          return this.finishFailure(
            run,
            'CODING_INVALID_PLAN',
            scrubCodingSecrets(decision.reason),
          );
        default:
          return this.finishFailure(run, 'CODING_INVALID_DECISION', 'unknown decision');
      }
    }
    return this.view(run);
  }

  private handlePlanDecision(run: ManagedRun, plan: CodingPlan): DriveOutcome {
    if (run.plan !== null) {
      throw new CodingError('CODING_INVALID_DECISION', 'a plan already exists for this run');
    }
    run.plan = plan;
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    run.state = transition(run.state, 'planning');
    audit('coding_plan_created', `Coding plan created: ${plan.goal.slice(0, 120)}`, {
      steps: plan.steps.length,
      filesToInspect: plan.filesToInspect.length,
      filesToModify: plan.filesToModify.length,
      validations: plan.validations.length,
    });
    if (this.requirePlanApproval && !run.planApproved) {
      run.pendingApproval = { kind: 'plan_approval' };
      run.resumeState = 'inspecting';
      run.state = transition(run.state, 'awaiting_approval');
      run.updatedAt = this.now();
      return this.view(run); // paused for human plan approval
    }
    run.planApproved = true;
    run.state = transition(run.state, 'inspecting');
    run.updatedAt = this.now();
    return null;
  }

  private async handleAction(
    run: ManagedRun,
    action: { type: string } & Record<string, unknown>,
  ): Promise<DriveOutcome> {
    if (run.plan === null || !run.planApproved) {
      return this.finishFailure(run, 'CODING_INVALID_DECISION', 'actions require an approved plan');
    }
    if (run.toolCalls >= run.limits.maxToolCalls) {
      return this.finishFailure(run, 'CODING_TOOL_CALL_LIMIT', 'tool-call limit reached');
    }
    let binding = bindCodingAction(action as never, run.request.projectId, run.request.workspaceId);
    // Optimistic revision protection (Step 7): every update carries the
    // revision this run last saw for the file. The decision source may pass
    // one explicitly (it only ever sees revisions as untrusted data); when it
    // does not, the manager substitutes its own tracked revision. A file the
    // run never read or created has no revision -> typed failure, no blind
    // overwrite.
    if (binding.toolId === CODING_TOOL_IDS.updateFile && binding.input.expectedRevision === -1) {
      const tracked = run.fileRevisions.get(String(binding.input.path));
      if (tracked === undefined) {
        return this.finishFailure(
          run,
          'CODING_STALE_REVISION',
          'update_file requires the file to be read or created by this run first',
        );
      }
      binding = { ...binding, input: { ...binding.input, expectedRevision: tracked } };
    }
    if (run.state !== binding.state) {
      run.state = transition(run.state, binding.state);
    }
    run.updatedAt = this.now();

    // Validation actions are bounded by the iteration limit and need a sandbox.
    if (binding.toolId === CODING_TOOL_IDS.sandboxExecute) {
      if (run.iterations >= run.limits.maxIterations) {
        return this.finishFailure(run, 'CODING_ITERATION_LIMIT', 'iteration limit reached');
      }
      const audit = createCodingAuditEmitter(run.request.runId, this.now);
      audit('coding_validation_started', `Validation requested: ${binding.input.command}`, {
        iteration: run.iterations + 1,
      });
      const sandboxReady = await this.ensureSandbox(run);
      if (sandboxReady !== true) {
        return sandboxReady; // paused or failed
      }
      // The sandbox id is NEVER taken from the decision source; the manager
      // pins it to the run's own validation sandbox.
      binding = { ...binding, input: { ...binding.input, sandboxId: run.sandboxId } };
    }

    const outcome = await this.invokeTool(run, binding.toolId, binding.input, undefined);
    if (outcome === null) {
      return this.view(run); // paused for human confirmation
    }
    if (run.state === 'failed') {
      return this.view(run); // fatal cause already ended the run
    }
    const processed = await this.processToolOutcome(run, binding.toolId, binding.input, outcome);
    if (processed !== null) {
      return processed;
    }
    if (run.consecutiveFailures >= run.limits.maxConsecutiveFailures) {
      return this.finishFailure(
        run,
        'CODING_CONSECUTIVE_FAILURES',
        `consecutive failure limit reached after ${run.lastFailure?.toolId ?? 'unknown tool'} (${run.lastFailure?.errorCode ?? 'TOOL_EXECUTION'})`,
      );
    }
    return null;
  }

  /**
   * Invokes one tool through the Tool System. Returns null when the run pauses
   * for a human confirmation. NO permission claims are passed - grants live in
   * the ToolManager, given only by trusted server-side wiring.
   */
  private async invokeTool(
    run: ManagedRun,
    toolId: string,
    input: Record<string, unknown>,
    confirmationId?: string,
  ): Promise<ToolInvocationResult | null> {
    const result = await this.tools.invoke(toolId, input, {
      requester: 'coding-agent',
      correlationId: run.request.runId,
      ...(confirmationId !== undefined ? { confirmationId } : {}),
    });
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    if (result.status === 'awaiting_confirmation' && result.confirmationId !== undefined) {
      run.toolCalls += 1;
      run.pendingApproval = {
        kind: 'tool_confirmation',
        toolId,
        confirmationId: result.confirmationId,
      };
      run.resumeState = run.state;
      this.resumeInputs.set(run.request.runId, input);
      run.state = transition(run.state, 'awaiting_approval');
      run.updatedAt = this.now();
      audit('coding_confirmation_requested', `Confirmation required for tool "${toolId}"`, {
        toolId,
        confirmationId: result.confirmationId,
      });
      return null;
    }
    run.toolCalls += 1;
    if (result.status === 'success') {
      run.consecutiveFailures = 0;
      audit('coding_tool_executed', `Tool "${toolId}" executed`, { toolId });
    } else {
      const error = (result as { error?: { code?: string } }).error;
      audit('coding_tool_denied', `Tool "${toolId}" denied/failed`, {
        toolId,
        errorCode: error?.code,
      });
    }
    return result;
  }

  /** Creates the run's validation sandbox (once) through the sandbox tool. */
  private async ensureSandbox(run: ManagedRun): Promise<true | CodingRunView> {
    if (run.sandboxId !== null) return true;
    const created = await this.invokeTool(run, CODING_TOOL_IDS.sandboxCreate, {
      workspaceRef: run.request.workspaceId,
    });
    if (created === null) {
      return this.view(run); // paused for confirmation
    }
    if (created.status !== 'success') {
      this.recordFailure(run, CODING_TOOL_IDS.sandboxCreate, created);
      return this.finishFailure(
        run,
        'CODING_CONSECUTIVE_FAILURES',
        'sandbox creation failed repeatedly',
      );
    }
    const sandboxId = (created as { output?: { sandboxId?: unknown } }).output?.sandboxId;
    if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
      return this.finishFailure(run, 'CODING_INVALID_REQUEST', 'sandbox creation returned no id');
    }
    run.sandboxId = sandboxId;
    return true;
  }

  /** Routes a completed tool outcome through result handling. */
  private async processToolOutcome(
    run: ManagedRun,
    toolId: string,
    input: Record<string, unknown>,
    result: ToolInvocationResult,
  ): Promise<DriveOutcome> {
    if (toolId === CODING_TOOL_IDS.sandboxExecute) {
      return this.applyValidationResult(run, String(input.command ?? ''), result);
    }
    this.applyActionResult(run, toolId, input, result);
    return null;
  }

  /** Applies a non-validation tool result to run state. Results are untrusted data. */
  private applyActionResult(
    run: ManagedRun,
    toolId: string,
    input: Record<string, unknown>,
    result: ToolInvocationResult,
  ): void {
    if (result.status === 'success') {
      const output = (result as { output?: Record<string, unknown> }).output ?? {};
      const path = typeof output.path === 'string' ? output.path : undefined;
      if (typeof output.workspaceRevision === 'number') {
        run.workspaceRevision = output.workspaceRevision;
      }
      const revision = typeof output.revision === 'number' ? output.revision : undefined;
      switch (toolId) {
        case CODING_TOOL_IDS.readFile:
          if (path !== undefined) {
            if (revision !== undefined) run.fileRevisions.set(path, revision);
            run.untrustedFiles.push({
              path,
              content: typeof output.content === 'string' ? output.content : '',
            });
            if (run.untrustedFiles.length > MAX_UNTRUSTED_CONTEXT_ITEMS) {
              run.untrustedFiles.shift();
            }
          }
          break;
        case CODING_TOOL_IDS.createFile:
          if (path !== undefined) {
            if (revision !== undefined) run.fileRevisions.set(path, revision);
            run.changedFiles.set(path, 'created');
          }
          break;
        case CODING_TOOL_IDS.updateFile:
          if (path !== undefined) {
            if (revision !== undefined) run.fileRevisions.set(path, revision);
            run.changedFiles.set(path, 'updated');
          }
          break;
        case CODING_TOOL_IDS.moveFile:
          if (path !== undefined) run.changedFiles.set(path, 'moved');
          break;
        case CODING_TOOL_IDS.deleteFile:
          if (typeof input.path === 'string') run.changedFiles.set(input.path, 'deleted');
          break;
        default:
          break;
      }
      return;
    }
    this.recordFailure(run, toolId, result);
  }

  /** Applies a validation result: failure iterates (bounded), success returns to editing. */
  private applyValidationResult(
    run: ManagedRun,
    command: string,
    result: ToolInvocationResult,
  ): DriveOutcome {
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    run.iterations += 1;
    if (result.status !== 'success') {
      this.recordFailure(run, CODING_TOOL_IDS.sandboxExecute, result);
      run.validationResults.push({
        command,
        status: 'failed',
        exitCode: null,
        timedOut: false,
        truncated: false,
        stdout: '',
        stderr: (result as { error?: { message?: string } }).error?.message ?? 'validation failed',
        passed: false,
      });
      audit('coding_validation_completed', `Validation failed: ${command}`, {
        iteration: run.iterations,
      });
      run.state = transition(run.state, 'iterating');
      run.updatedAt = this.now();
      if (run.consecutiveFailures >= run.limits.maxConsecutiveFailures) {
        return this.finishFailure(
          run,
          'CODING_CONSECUTIVE_FAILURES',
          `validation failed repeatedly after ${run.lastFailure?.toolId ?? 'unknown tool'} (${run.lastFailure?.errorCode ?? 'TOOL_EXECUTION'})`,
        );
      }
      return null;
    }
    const output = (result as { output?: Record<string, unknown> }).output ?? {};
    const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;
    const passed = output.status === 'completed' && exitCode === 0;
    run.validationResults.push({
      command,
      status: typeof output.status === 'string' ? output.status : 'unknown',
      exitCode,
      timedOut: output.timedOut === true,
      truncated: output.truncated === true,
      stdout: typeof output.stdout === 'string' ? output.stdout.slice(0, 2000) : '',
      stderr: typeof output.stderr === 'string' ? output.stderr.slice(0, 2000) : '',
      passed,
    });
    audit('coding_validation_completed', `Validation ${passed ? 'passed' : 'failed'}: ${command}`, {
      iteration: run.iterations,
      exitCode,
    });
    if (!passed) {
      audit('coding_iteration_started', 'Iteration after failed validation', {
        iteration: run.iterations,
      });
      if (run.iterations >= run.limits.maxIterations) {
        return this.finishFailure(run, 'CODING_ITERATION_LIMIT', 'iteration limit reached');
      }
      run.state = transition(run.state, 'iterating');
    } else {
      run.state = transition(run.state, 'editing');
    }
    run.updatedAt = this.now();
    return null;
  }

  private recordFailure(run: ManagedRun, toolId: string, result: ToolInvocationResult): void {
    run.consecutiveFailures += 1;
    const error = (result as { error?: { code?: string; message?: string } }).error;
    run.lastFailure = { toolId, errorCode: error?.code ?? 'TOOL_EXECUTION' };
    const cause = (error as { details?: { cause?: string } } | undefined)?.details?.cause;
    // Fatal engine causes end the run with a precise typed code.
    if (cause === 'PROJECT_NOT_FOUND') {
      this.finishFailure(
        run,
        'CODING_PROJECT_NOT_FOUND',
        `project not found (PROJECT_NOT_FOUND via ${toolId})`,
      );
      return;
    }
    if (cause === 'WORKSPACE_NOT_FOUND') {
      this.finishFailure(
        run,
        'CODING_WORKSPACE_NOT_FOUND',
        `workspace not found (WORKSPACE_NOT_FOUND via ${toolId})`,
      );
      return;
    }
    if (cause === 'PROJECT_ARCHIVED' || cause === 'PROJECT_DELETED') {
      this.finishFailure(
        run,
        'CODING_PROJECT_NOT_ACTIVE',
        `project is not active (${cause} via ${toolId})`,
      );
      return;
    }
    if (cause === 'WORKSPACE_MISMATCH') {
      this.finishFailure(
        run,
        'CODING_INVALID_REQUEST',
        'workspace does not belong to this project',
      );
      return;
    }
    this.recordToolDenial(
      run,
      toolId,
      error?.code ?? 'TOOL_EXECUTION',
      error?.message ?? 'tool failed',
    );
  }

  private recordToolDenial(
    run: ManagedRun,
    toolId: string,
    errorCode: string,
    errorMessage: string,
  ): void {
    run.consecutiveFailures += 1;
    run.lastFailure = { toolId, errorCode };
    run.untrustedToolResults.push({
      toolId,
      status: 'denied',
      errorCode,
      errorMessage: scrubCodingSecrets(errorMessage).slice(0, 500),
    });
    if (run.untrustedToolResults.length > MAX_UNTRUSTED_CONTEXT_ITEMS) {
      run.untrustedToolResults.shift();
    }
  }

  private finishCompletion(run: ManagedRun, summary: string): CodingRunView {
    if (run.plan === null) {
      return this.finishFailure(run, 'CODING_INVALID_DECISION', 'cannot complete without a plan');
    }
    run.summary = scrubCodingSecrets(summary);
    run.pendingApproval = null;
    run.state = transition(run.state, 'completed');
    run.updatedAt = this.now();
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    audit('coding_run_completed', 'Coding run completed', {
      changedFiles: [...run.changedFiles.keys()],
      iterations: run.iterations,
      toolCalls: run.toolCalls,
    });
    return this.view(run);
  }

  private finishFailure(run: ManagedRun, code: string, message: string): CodingRunView {
    if (isCodingRunTerminal(run.state)) {
      return this.view(run);
    }
    run.failure = { code, message: scrubCodingSecrets(message) };
    run.pendingApproval = null;
    run.resumeState = null;
    this.resumeInputs.delete(run.request.runId);
    run.state = transition(run.state, 'failed');
    run.updatedAt = this.now();
    const audit = createCodingAuditEmitter(run.request.runId, this.now);
    audit('coding_run_failed', `Coding run failed: ${run.failure.message}`, {
      code: run.failure.code,
      committedFiles: [...run.changedFiles.keys()],
    });
    return this.view(run);
  }

  private assertDuration(run: ManagedRun): void {
    const elapsed = this.now().getTime() - run.startedAt.getTime();
    if (elapsed > run.limits.maxDurationMs) {
      this.finishFailure(run, 'CODING_DURATION_LIMIT', 'duration limit reached');
    }
  }

  /** Builds the decision context. Untrusted fields are named as such. */
  private buildContext(run: ManagedRun): CodingDecisionContext {
    return {
      runId: run.request.runId,
      projectId: run.request.projectId,
      workspaceId: run.request.workspaceId,
      state: run.state,
      userRequirement: run.request.userRequirement,
      constraints: run.request.constraints ?? [],
      acceptanceCriteria: run.request.acceptanceCriteria ?? [],
      targetFiles: run.request.targetFiles ?? [],
      plan: run.plan,
      iterations: run.iterations,
      toolCalls: run.toolCalls,
      workspaceRevision: run.workspaceRevision,
      sandboxId: run.sandboxId,
      untrustedFiles: [...run.untrustedFiles],
      untrustedToolResults: [...run.untrustedToolResults],
      validationResults: [...run.validationResults],
      changedFiles: [...run.changedFiles.keys()],
    };
  }

  private view(run: ManagedRun): CodingRunView {
    return {
      runId: run.request.runId,
      projectId: run.request.projectId,
      workspaceId: run.request.workspaceId,
      state: run.state,
      summary: run.summary,
      changedFiles: [...run.changedFiles.keys()],
      validationResults: [...run.validationResults],
      iterations: run.iterations,
      toolCalls: run.toolCalls,
      startedAt: run.startedAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      pendingApproval: run.pendingApproval,
      failure: run.failure,
    };
  }

  /** Stored pending inputs for confirmation resumes (input-bound, single-use). */
  private readonly resumeInputs = new Map<string, Record<string, unknown>>();
}

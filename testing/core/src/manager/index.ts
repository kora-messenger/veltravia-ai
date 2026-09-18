/**
 * TestingManager: creates, plans, approves, drives, inspects, and cancels
 * TestRuns.
 *
 * The pipeline is BOUNDED and OBSERVABLE:
 *
 *   detect -> structured TestPlan -> HUMAN approval -> run commands through
 *   the Tool System into the Secure Sandbox -> structured results -> on
 *   failure: deterministic classification -> DebugAgent diagnosis ->
 *   typed RepairPlan -> HUMAN approval (the Coding Agent's own plan approval
 *   IS the repair approval - no second mechanism) -> repair applied by the
 *   existing Coding Agent -> retest -> (bounded repair loop) -> result
 *
 * This manager never touches the host filesystem, a shell, the environment,
 * credentials, or a provider SDK. There is NO second execution pathway:
 * every command is sandbox.execute through the Tool System (its forced human
 * confirmation is preserved), and every code mutation is applied by the
 * Coding Agent through the Tool System with revision discipline. Test output
 * and project file content are UNTRUSTED DATA throughout - never instructions.
 */

import { CodingAgentManager, type CodingRunView } from '@veltravia/coding-agent-core';
import type { ToolInvocationResult, ToolManager } from '@veltravia/tool-core';

import { bindTestAudit, type TestAuditEventType, type TestAuditSink } from '../audit/index.js';
import {
  detectProject,
  rederiveScriptCommand,
  MANIFEST_PATH,
  type FileNodeView,
} from '../detection/index.js';
import { classifyFailure, extractAffectedPaths } from '../diagnostics/index.js';
import type { DebugAgent } from '../debugger/index.js';
import { createRepairDecisionSource } from '../debugger/repair-source.js';
import { isTestingError, scrubTestingSecrets, TestingError } from '../errors/index.js';
import { summarizeUntrustedOutput } from '../errors/scrub.js';
import {
  resolveTestRunLimits,
  validateDiagnosis,
  validateRepairPlan,
  validateTestPlan,
  validateTestRunRequest,
} from '../policy/index.js';
import { transition } from '../state/index.js';
import { isTestRunTerminal } from '../types/index.js';
import type {
  Diagnosis,
  RepairPlan,
  RepairPlanView,
  RevisionConflictResult,
  TestCommand,
  TestCommandResult,
  TestPassResult,
  TestPendingApproval,
  TestPlan,
  TestPlanView,
  TestRunFailure,
  TestRunLimits,
  TestRunState,
  TestRunView,
} from '../types/index.js';

/** The Tool System tool ids this manager binds to (code, never model choice). */
export const TESTING_TOOL_IDS = {
  listFiles: 'project.list-files',
  readFile: 'project.read-file',
  sandboxCreate: 'sandbox.create',
  sandboxExecute: 'sandbox.execute',
} as const;

const TOOL_PROJECT_LIST_FILES = TESTING_TOOL_IDS.listFiles;
const TOOL_PROJECT_READ_FILE = TESTING_TOOL_IDS.readFile;
const TOOL_SANDBOX_CREATE = TESTING_TOOL_IDS.sandboxCreate;
const TOOL_SANDBOX_EXECUTE = TESTING_TOOL_IDS.sandboxExecute;

const REVISION_CONFLICT_CODING_CODES = new Set(['CODING_STALE_REVISION']);
const MAX_MANIFEST_BYTES = 65_536;

/** Manifest read outcome (paused = a confirmation interrupted the read). */
interface ManifestRead {
  readonly paused: boolean;
  readonly failed: boolean;
  readonly manifest: unknown;
  readonly bytes: number | null;
  readonly message: string;
}

/** One managed run's mutable bookkeeping (single-threaded, in-process). */
interface ManagedRun {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly createdAt: Date;
  state: TestRunState;
  plan: TestPlan | null;
  pass: 'initial' | 'retest';
  resolvedCommands: readonly TestCommand[];
  commandCursor: number;
  passResults: TestCommandResult[];
  results: TestPassResult | null;
  retestResults: TestPassResult | null;
  diagnosis: Diagnosis | null;
  repairPlan: RepairPlan | null;
  repairAttempts: number;
  commandsExecuted: number;
  sandboxId: string | null;
  codingRunId: string | null;
  coding: CodingRepairHandle | null;
  revisionConflict: RevisionConflictResult | null;
  pendingApproval: TestPendingApproval | null;
  /** Phase to return to after a paused tool confirmation resumes. */
  resumeState: TestRunState | null;
  /** Stored input for the paused invocation; null for coding-forwarded gates. */
  resumeInput: Record<string, unknown> | null;
  cancelled: boolean;
  failure: TestRunFailure | null;
  notes: string[];
  updatedAt: Date;
}

/** Narrow handle over one Coding Agent repair run (start/approve/cancel). */
export interface CodingRepairHandle {
  start(): Promise<CodingRunView>;
  getRun(): CodingRunView;
  submitApproval(decision: 'approve' | 'reject'): Promise<CodingRunView>;
  cancel(): CodingRunView;
}

/** Builds one isolated Coding Agent repair run for one repair plan. */
export type CodingRepairRunner = (input: {
  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly repairPlan: RepairPlan;
}) => CodingRepairHandle;

export interface TestingManagerOptions {
  /** The Tool System - the ONLY path to project files and the sandbox. */
  readonly tools: ToolManager;
  /** Provider-neutral diagnosis + repair proposals (mock or AI-routed later). */
  readonly debugAgent: DebugAgent;
  /** Builds the Coding Agent repair runs; defaults to the real CodingAgentManager. */
  readonly codingRepairRunner?: CodingRepairRunner;
  readonly limits?: Partial<TestRunLimits>;
  readonly now?: () => Date;
  readonly generateRunId?: () => string;
  readonly onAudit?: TestAuditSink;
}

export class TestingManager {
  private readonly tools: ToolManager;
  private readonly debugAgent: DebugAgent;
  private readonly codingRepairRunner: CodingRepairRunner;
  private readonly limits: TestRunLimits;
  private readonly now: () => Date;
  private readonly generateRunId: () => string;
  private readonly auditSink: TestAuditSink | undefined;
  private readonly runs = new Map<string, ManagedRun>();

  constructor(options: TestingManagerOptions) {
    this.tools = options.tools;
    this.debugAgent = options.debugAgent;
    this.limits = resolveTestRunLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.generateRunId =
      options.generateRunId ?? (() => `testrun_${Math.random().toString(36).slice(2, 12)}`);
    this.auditSink = options.onAudit;
    this.codingRepairRunner = options.codingRepairRunner ?? defaultCodingRepairRunner(options);
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Creates a run, detects the project, plans, and pauses for approval. */
  async startRun(request: {
    readonly runId?: unknown;
    readonly projectId: unknown;
    readonly workspaceId: unknown;
  }): Promise<TestRunView> {
    const validated = validateTestRunRequest(request);
    const runId = validated.runId ?? this.generateRunId();
    if (this.runs.has(runId)) {
      throw new TestingError('TESTING_INVALID_REQUEST', `run "${runId}" already exists`, {
        details: { runId },
      });
    }
    const run: ManagedRun = {
      runId,
      projectId: validated.projectId,
      workspaceId: validated.workspaceId,
      createdAt: this.now(),
      state: 'created',
      plan: null,
      pass: 'initial',
      resolvedCommands: [],
      commandCursor: 0,
      passResults: [],
      results: null,
      retestResults: null,
      diagnosis: null,
      repairPlan: null,
      repairAttempts: 0,
      commandsExecuted: 0,
      sandboxId: null,
      codingRunId: null,
      coding: null,
      revisionConflict: null,
      pendingApproval: null,
      resumeState: null,
      resumeInput: null,
      cancelled: false,
      failure: null,
      notes: [],
      updatedAt: this.now(),
    };
    this.runs.set(runId, run);
    this.auditFor(run)('testing_run_started', {
      runId,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
    });
    run.state = transition(run.state, 'planning');
    run.updatedAt = this.now();
    return this.phaseDetectAndPlan(run);
  }

  /** Safe view of one run. Never exposes secrets or chain-of-thought. */
  getRun(runId: string): TestRunView {
    return this.view(this.run(runId));
  }

  /** Safe plan view, or a typed error when planning has not completed. */
  getPlan(runId: string): TestPlanView {
    const run = this.run(runId);
    if (run.plan === null) {
      throw new TestingError('TESTING_INVALID_REQUEST', 'the run has no plan yet', {
        details: { runId, state: run.state },
      });
    }
    return this.planView(run.plan);
  }

  /** Safe results view (nulls until the passes complete). */
  getResults(runId: string): {
    readonly results: TestPassResult | null;
    readonly retestResults: TestPassResult | null;
  } {
    const run = this.run(runId);
    return { results: run.results, retestResults: run.retestResults };
  }

  /** Safe diagnostics view (null until a failure was analyzed). */
  getDiagnostics(runId: string): { readonly diagnosis: Diagnosis | null } {
    const run = this.run(runId);
    return { diagnosis: run.diagnosis };
  }

  /**
   * Submits ONE human decision for the paused run. The pending kind decides
   * the gate: plan approval, a forced tool confirmation, or repair approval.
   * Nothing is ever auto-approved; a rejection is terminal and honest.
   */
  async submitApproval(runId: string, decision: 'approve' | 'reject'): Promise<TestRunView> {
    const run = this.run(runId);
    if (isTestRunTerminal(run.state)) {
      throw new TestingError('TESTING_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        details: { runId, state: run.state },
      });
    }
    const pending = run.pendingApproval;
    if (pending === null) {
      throw new TestingError('TESTING_NOT_AWAITING_APPROVAL', `run "${runId}" is not paused`, {
        details: { runId, state: run.state },
      });
    }
    switch (pending.kind) {
      case 'plan_approval':
        return this.resolvePlanApproval(run, decision);
      case 'tool_confirmation':
        return this.resolveToolConfirmation(run, decision);
      case 'repair_approval':
        return this.resolveRepairApproval(run, decision);
    }
  }

  /** One-way, terminal cancellation. Committed mutations are kept; nothing new runs. */
  cancelRun(runId: string): TestRunView {
    const run = this.run(runId);
    if (isTestRunTerminal(run.state)) {
      throw new TestingError('TESTING_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        details: { runId, state: run.state },
      });
    }
    const audit = this.auditFor(run);
    run.cancelled = true;
    run.pendingApproval = null;
    run.resumeState = null;
    run.resumeInput = null;
    if (run.coding !== null) {
      try {
        run.coding.cancel();
      } catch {
        // The coding run may already be terminal; its state stays its own.
      }
      run.coding = null;
    }
    run.state = transition(run.state, 'cancelled');
    run.updatedAt = this.now();
    audit('testing_run_cancelled', { runId });
    return this.view(run);
  }

  // ---- planning ---------------------------------------------------------------

  /** Detects the project (structure + manifest through the Tool System) and
   * builds the validated TestPlan, then pauses for human approval. */
  private async phaseDetectAndPlan(run: ManagedRun): Promise<TestRunView> {
    const audit = this.auditFor(run);

    // Structure only (safe node views, no content) - through the Tool System.
    const listed = await this.invokeTool(run, TOOL_PROJECT_LIST_FILES, {
      workspaceId: run.workspaceId,
    });
    if (listed === null) return this.view(run); // paused for confirmation
    if (listed.status !== 'success') {
      return this.failRun(run, 'TESTING_TOOL_ERROR', 'the workspace could not be listed', {
        toolId: TOOL_PROJECT_LIST_FILES,
        errorCode: (listed as { error?: { code?: string } }).error?.code,
      });
    }
    const nodes = extractNodes(listed);
    const hasManifest = nodes.some((node) => node.path === MANIFEST_PATH && node.type === 'file');
    let manifestRead: ManifestRead = {
      paused: false,
      failed: false,
      manifest: null,
      bytes: null,
      message: '',
    };
    if (hasManifest) {
      const read = await this.readManifest(run);
      if (read.paused) return this.view(run); // paused for confirmation
      if (read.failed) {
        return this.failRun(run, 'TESTING_TOOL_ERROR', read.message, {
          toolId: TOOL_PROJECT_READ_FILE,
        });
      }
      manifestRead = read;
    }

    const detectionResult = detectProject({
      nodes,
      manifest: manifestRead.manifest,
      manifestBytes: manifestRead.bytes,
    });
    const plan: TestPlan = {
      version: '1.0.0',
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      projectType: detectionResult.detection.projectType,
      detection: detectionResult.detection,
      validationSteps: detectionResult.commands.map(
        (command) => `Run the ${command.label} command`,
      ),
      commands: detectionResult.commands,
      commandTimeoutMs: this.limits.maxCommandTimeoutMs,
      requiredPermissions: ['project.read', 'project.write', 'sandbox.create', 'sandbox.execute'],
      repairAllowed: true,
      notes: detectionResult.detection.notes,
    };
    let validated: TestPlan;
    try {
      validated = validateTestPlan(plan);
    } catch (error) {
      const code =
        isTestingError(error) && error.code === 'TESTING_UNSUPPORTED_PROJECT'
          ? 'TESTING_UNSUPPORTED_PROJECT'
          : 'TESTING_INVALID_PLAN';
      return this.failRun(
        run,
        code,
        isTestingError(error) ? error.message : 'the derived test plan is invalid',
      );
    }
    run.plan = validated;
    run.notes = [...run.notes, ...validated.notes];
    audit('testing_plan_created', {
      runId: run.runId,
      projectType: validated.projectType,
      commandCount: validated.commands.length,
    });
    run.pendingApproval = { kind: 'plan_approval' };
    run.state = transition(run.state, 'awaiting_approval');
    run.updatedAt = this.now();
    return this.view(run);
  }

  private async resolvePlanApproval(
    run: ManagedRun,
    decision: 'approve' | 'reject',
  ): Promise<TestRunView> {
    const audit = this.auditFor(run);
    run.pendingApproval = null;
    run.resumeState = null;
    run.resumeInput = null;
    if (decision === 'reject') {
      audit('testing_plan_rejected', { runId: run.runId });
      return this.failRun(run, 'TESTING_PLAN_REJECTED', 'the test plan was rejected by a human');
    }
    audit('testing_plan_approved', { runId: run.runId });
    run.state = transition(run.state, 'approved');
    run.updatedAt = this.now();
    return this.startPass(run, 'initial');
  }

  // ---- command passes -------------------------------------------------------

  /** Starts one command pass (initial run or retest). */
  private async startPass(run: ManagedRun, pass: 'initial' | 'retest'): Promise<TestRunView> {
    const audit = this.auditFor(run);
    run.pass = pass;
    run.commandCursor = 0;
    run.passResults = [];
    run.resolvedCommands = [];
    if (pass === 'retest') {
      run.state = transition(run.state, 'retesting');
      audit('testing_retest_started', { runId: run.runId, attempt: run.repairAttempts });
    } else {
      run.state = transition(run.state, 'running');
    }
    run.updatedAt = this.now();

    // Resolve script-derived commands from the CURRENT manifest (honest
    // retest: a repair that fixed the script is retested against the fixed
    // value). Everything structural is re-validated by the policy layer.
    const resolved: TestCommand[] = [];
    for (const command of run.plan?.commands ?? []) {
      if (command.scriptName === undefined) {
        resolved.push(command);
        continue;
      }
      const manifestRead = await this.readManifest(run);
      if (manifestRead.paused) return this.view(run); // paused for confirmation
      if (manifestRead.failed) {
        return this.failRun(
          run,
          'TESTING_TOOL_ERROR',
          `the manifest could not be read to resolve the "${command.scriptName}" script`,
          { toolId: TOOL_PROJECT_READ_FILE },
        );
      }
      let rederived: TestCommand | null;
      try {
        rederived = rederiveScriptCommand(command.scriptName, manifestRead.manifest);
      } catch (error) {
        return this.failRun(
          run,
          'TESTING_INVALID_PLAN',
          isTestingError(error) ? error.message : 'the script could not be re-derived',
        );
      }
      if (rederived === null) {
        return this.failRun(
          run,
          'TESTING_INVALID_PLAN',
          `the "${command.scriptName}" script is no longer present or derivable as a bare command`,
        );
      }
      resolved.push({ ...rederived, purpose: command.purpose, label: command.label });
    }
    run.resolvedCommands = resolved;
    if (resolved.length === 0) {
      run.notes.push('no test commands were planned for this pass');
    }
    return this.drivePass(run);
  }

  /** Drives the current pass: sandbox + commands, one by one. */
  private async drivePass(run: ManagedRun): Promise<TestRunView> {
    const audit = this.auditFor(run);
    if (run.cancelled || isTestRunTerminal(run.state)) return this.view(run);

    if (run.sandboxId === null) {
      const created = await this.invokeTool(run, TOOL_SANDBOX_CREATE, {
        workspaceRef: run.workspaceId,
      });
      if (created === null) return this.view(run); // paused for confirmation
      if (created.status !== 'success') {
        return this.failRun(run, 'TESTING_TOOL_ERROR', 'sandbox creation failed', {
          toolId: TOOL_SANDBOX_CREATE,
          errorCode: (created as { error?: { code?: string } }).error?.code,
        });
      }
      const sandboxId = ((created.output ?? {}) as { sandboxId?: unknown }).sandboxId;
      if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
        return this.failRun(run, 'TESTING_TOOL_ERROR', 'sandbox creation returned no id');
      }
      run.sandboxId = sandboxId;
    }

    while (run.commandCursor < run.resolvedCommands.length) {
      if (run.cancelled || isTestRunTerminal(run.state)) return this.view(run);
      if (run.commandsExecuted >= this.limits.maxCommands) {
        return this.failRun(
          run,
          'TESTING_COMMAND_LIMIT',
          `command limit reached (${this.limits.maxCommands})`,
        );
      }
      const command = run.resolvedCommands[run.commandCursor] as TestCommand;
      const result = await this.invokeTool(run, TOOL_SANDBOX_EXECUTE, {
        sandboxId: run.sandboxId,
        command: command.executable,
        arguments: [...command.arguments],
      });
      if (result === null) return this.view(run); // paused for confirmation
      run.commandsExecuted += 1;
      const recorded = this.recordCommandResult(run, command, result);
      run.updatedAt = this.now();
      audit('testing_command_executed', {
        runId: run.runId,
        pass: run.pass,
        label: command.label,
        purpose: command.purpose,
        success: recorded.success,
        exitCode: recorded.exitCode,
      });
      run.commandCursor += 1;
      if (!recorded.success) {
        return this.finishPassWithFailure(run, recorded);
      }
    }
    return this.finishPassWithSuccess(run);
  }

  /** The pass fully succeeded. */
  private finishPassWithSuccess(run: ManagedRun): TestRunView {
    const audit = this.auditFor(run);
    const passResult: TestPassResult = {
      executed: run.passResults.length > 0,
      success: true,
      results: [...run.passResults],
      failedCommandIndex: null,
      failureCategory: null,
      notes: run.passResults.length === 0 ? ['no commands were planned or run'] : [],
    };
    if (run.pass === 'initial') {
      run.results = passResult;
    } else {
      run.retestResults = passResult;
    }
    audit('testing_test_pass_result', { runId: run.runId, pass: run.pass, success: true });
    audit('testing_run_completed', { runId: run.runId, pass: run.pass });
    run.state = transition(run.state, 'completed');
    run.updatedAt = this.now();
    return this.view(run);
  }

  /** The pass failed: classify, then analyze within the bounded loop. */
  private async finishPassWithFailure(
    run: ManagedRun,
    recorded: TestCommandResult,
  ): Promise<TestRunView> {
    const audit = this.auditFor(run);
    const classification = classifyFailure(recorded);
    const affectedPaths = extractAffectedPaths(recorded);
    const passResult: TestPassResult = {
      executed: true,
      success: false,
      results: [...run.passResults],
      failedCommandIndex: recorded.index,
      failureCategory: classification.category,
      notes: [],
    };
    if (run.pass === 'initial') {
      run.results = passResult;
    } else {
      run.retestResults = passResult;
    }
    audit('testing_test_pass_result', {
      runId: run.runId,
      pass: run.pass,
      success: false,
      category: classification.category,
    });
    return this.phaseAnalyzing(run, recorded, classification, affectedPaths);
  }

  // ---- analysis + repair ----------------------------------------------------

  /**
   * Phase: analyze the failure with the DebugAgent. The agent receives the
   * bounded untrusted outputs plus file contents read through the Tool
   * System; its output is validated before anything can happen.
   */
  private async phaseAnalyzing(
    run: ManagedRun,
    failedCommand: TestCommandResult,
    classification: ReturnType<typeof classifyFailure>,
    affectedPaths: readonly string[],
  ): Promise<TestRunView> {
    const audit = this.auditFor(run);
    run.state = transition(run.state, 'analyzing');
    run.updatedAt = this.now();
    audit('testing_analysis_started', {
      runId: run.runId,
      category: classification.category,
      confidence: classification.confidence,
    });

    // Read candidate files for diagnosis (bounded, untrusted content).
    const candidates = new Set<string>([...affectedPaths, MANIFEST_PATH]);
    const untrustedFiles: { path: string; content: string }[] = [];
    for (const path of candidates) {
      if (untrustedFiles.length >= this.limits.maxDebugFiles) break;
      const read = await this.invokeTool(run, TOOL_PROJECT_READ_FILE, {
        workspaceId: run.workspaceId,
        path,
      });
      if (read === null) return this.view(run); // paused for confirmation
      if (read.status !== 'success') continue; // missing/unreadable: skip
      const output = (read.output ?? {}) as { content?: unknown };
      if (typeof output.content === 'string') {
        untrustedFiles.push({ path, content: output.content });
      }
    }

    let proposal;
    try {
      proposal = await this.debugAgent.analyze({
        runId: run.runId,
        attempt: run.repairAttempts + 1,
        plan: run.plan as TestPlan,
        failure: {
          failedCommand,
          failureCategory: classification.category,
          categoryConfidence: classification.confidence,
          affectedPaths,
        },
        untrustedFiles,
      });
      validateDiagnosis(proposal.diagnosis);
      if (proposal.repairPlan !== null) {
        validateRepairPlan(proposal.repairPlan);
      }
    } catch (error) {
      const message = isTestingError(error)
        ? error.message
        : 'the debug agent produced an invalid proposal';
      return this.failRun(run, 'TESTING_INVALID_DIAGNOSIS', message);
    }

    run.diagnosis = proposal.diagnosis;
    audit('testing_diagnosis_created', {
      runId: run.runId,
      category: proposal.diagnosis.category,
      confidence: proposal.diagnosis.confidence,
    });

    if (proposal.repairPlan === null) {
      const reason = proposal.declinedReason ?? 'no confident repair was identified';
      run.notes.push(`repair declined: ${reason}`);
      return this.failRun(
        run,
        'TESTING_TEST_FAILED',
        `tests failed and no repair was proposed (${reason})`,
      );
    }
    if (run.plan?.repairAllowed !== true) {
      return this.failRun(run, 'TESTING_TEST_FAILED', 'repairs are not allowed for this plan');
    }
    if (run.repairAttempts >= this.limits.maxRepairAttempts) {
      return this.failRun(
        run,
        'TESTING_REPAIR_LIMIT',
        `repair limit reached (${this.limits.maxRepairAttempts} attempts)`,
      );
    }
    run.repairPlan = proposal.repairPlan;
    audit('testing_repair_proposed', {
      runId: run.runId,
      changes: proposal.repairPlan.changes.length,
      risk: proposal.repairPlan.risk,
    });

    // Start the Coding Agent repair run. Its OWN plan approval IS the human
    // gate for code-changing repairs - no second, weaker mechanism exists.
    const handle = this.codingRepairRunner({
      runId: run.runId,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      repairPlan: proposal.repairPlan,
    });
    run.coding = handle;
    let codingView: CodingRunView;
    try {
      codingView = await handle.start();
    } catch (error) {
      run.coding = null;
      return this.failRun(
        run,
        'TESTING_REPAIR_FAILED',
        isTestingError(error) ? error.message : 'the coding repair run could not start',
      );
    }
    run.codingRunId = codingView.runId;
    return this.applyCodingView(run, codingView);
  }

  /**
   * Maps the coding run's state onto this run: a paused plan approval becomes
   * the repair approval; completion moves to retest; failures fail this run
   * with the honest cause (revision conflicts surface structured, no retry).
   */
  private async applyCodingView(run: ManagedRun, codingView: CodingRunView): Promise<TestRunView> {
    const audit = this.auditFor(run);
    run.updatedAt = this.now();
    const pending = codingView.pendingApproval;
    if (codingView.state === 'awaiting_approval' && pending !== null) {
      if (pending.kind === 'plan_approval') {
        run.state = transition(run.state, 'awaiting_repair_approval');
        run.pendingApproval = {
          kind: 'repair_approval',
          repairPlan: this.repairPlanView(run.repairPlan as RepairPlan),
          codingRunId: codingView.runId,
        };
        return this.view(run);
      }
      if (pending.kind === 'tool_confirmation') {
        // The coding run paused for its OWN forced confirmation (e.g. a
        // high-risk tool). Forward the human's decision to it - resumeInput
        // stays null so this gate is recognizable as coding-forwarded.
        run.state = transition(run.state, 'repairing');
        run.resumeState = 'repairing';
        run.resumeInput = null;
        run.pendingApproval = {
          kind: 'tool_confirmation',
          toolId: pending.toolId,
          confirmationId: pending.confirmationId,
        };
        return this.view(run);
      }
    }
    if (codingView.state === 'completed') {
      run.repairAttempts += 1;
      audit('testing_repair_applied', {
        runId: run.runId,
        codingRunId: codingView.runId,
        changedFiles: [...codingView.changedFiles],
        attempt: run.repairAttempts,
      });
      run.coding = null;
      return this.startPass(run, 'retest');
    }
    if (codingView.state === 'failed' || codingView.state === 'cancelled') {
      const failure = codingView.failure;
      if (failure !== null && REVISION_CONFLICT_CODING_CODES.has(failure.code)) {
        audit('testing_revision_conflict', { runId: run.runId, codingRunId: codingView.runId });
        run.revisionConflict = {
          path: null,
          expectedRevision: null,
          currentRevision: null,
          message: scrubTestingSecrets(failure.message).slice(0, 500),
        };
        run.coding = null;
        return this.failRun(
          run,
          'TESTING_REVISION_CONFLICT',
          'the project changed while the repair was pending; no file was overwritten',
          { codingFailure: failure.code },
        );
      }
      audit('testing_repair_failed', {
        runId: run.runId,
        codingRunId: codingView.runId,
        code: failure?.code ?? codingView.state,
      });
      run.coding = null;
      return this.failRun(
        run,
        'TESTING_REPAIR_FAILED',
        `the coding repair run ${codingView.state}`,
        { codingFailure: failure?.code ?? null, changedFiles: [...codingView.changedFiles] },
      );
    }
    // Still executing: surface the repairing phase honestly.
    if (run.state !== 'repairing') {
      run.state = transition(run.state, 'repairing');
    }
    return this.view(run);
  }

  private async resolveRepairApproval(
    run: ManagedRun,
    decision: 'approve' | 'reject',
  ): Promise<TestRunView> {
    const audit = this.auditFor(run);
    run.pendingApproval = null;
    if (decision === 'reject') {
      audit('testing_repair_rejected', { runId: run.runId });
      if (run.coding !== null) {
        try {
          run.coding.cancel();
        } catch {
          // The coding run may already be terminal.
        }
        run.coding = null;
      }
      return this.failRun(
        run,
        'TESTING_REPAIR_REJECTED',
        'the repair plan was rejected by a human; no file was changed',
      );
    }
    audit('testing_repair_approved', { runId: run.runId });
    run.state = transition(run.state, 'repairing');
    run.updatedAt = this.now();
    return this.driveCoding(run, 'approve');
  }

  /** Forwards a decision to the coding run and maps its next view. */
  private async driveCoding(run: ManagedRun, decision: 'approve' | 'reject'): Promise<TestRunView> {
    if (run.coding === null) {
      return this.failRun(run, 'TESTING_REPAIR_FAILED', 'the coding repair run is gone');
    }
    let codingView: CodingRunView;
    try {
      codingView = await run.coding.submitApproval(decision);
    } catch (error) {
      return this.failRun(
        run,
        'TESTING_REPAIR_FAILED',
        isTestingError(error) ? error.message : 'the coding repair run rejected the decision',
      );
    }
    return this.applyCodingView(run, codingView);
  }

  // ---- tool invocation (the ONLY execution path) ------------------------------

  /**
   * Invokes one tool through the Tool System. Returns null when the run
   * pauses for a human confirmation (the stored input is re-submitted on
   * resume - the tool never executed, so no mutation can duplicate).
   */
  private async invokeTool(
    run: ManagedRun,
    toolId: string,
    input: Record<string, unknown>,
    confirmationId?: string,
  ): Promise<ToolInvocationResult | null> {
    const result = await this.tools.invoke(toolId, input, {
      requester: 'testing-agent',
      correlationId: run.runId,
      ...(confirmationId !== undefined ? { confirmationId } : {}),
    });
    if (result.status === 'awaiting_confirmation' && result.confirmationId !== undefined) {
      run.pendingApproval = {
        kind: 'tool_confirmation',
        toolId,
        confirmationId: result.confirmationId,
      };
      run.resumeState = run.state;
      run.resumeInput = input;
      if (run.state !== 'awaiting_approval') {
        run.state = transition(run.state, 'awaiting_approval');
      }
      run.updatedAt = this.now();
      this.auditFor(run)('testing_confirmation_requested', {
        runId: run.runId,
        toolId,
        confirmationId: result.confirmationId,
      });
      return null;
    }
    return result;
  }

  /** Resumes a paused tool confirmation with the STORED input. */
  private async resolveToolConfirmation(
    run: ManagedRun,
    decision: 'approve' | 'reject',
  ): Promise<TestRunView> {
    const pending = run.pendingApproval;
    const audit = this.auditFor(run);
    if (pending === null || pending.kind !== 'tool_confirmation') {
      throw new TestingError('TESTING_NOT_AWAITING_APPROVAL', 'no tool confirmation is pending');
    }
    run.pendingApproval = null;

    // Coding-forwarded gate (resumeInput is null): hand the decision back.
    if (run.resumeInput === null) {
      run.resumeState = null;
      if (decision === 'reject') {
        if (run.coding !== null) {
          try {
            run.coding.cancel();
          } catch {
            // The coding run may already be terminal.
          }
          run.coding = null;
        }
        audit('testing_confirmation_resumed', { runId: run.runId, approved: false });
        return this.failRun(
          run,
          'TESTING_REPAIR_REJECTED',
          'a human rejected the coding run tool confirmation; no further mutation ran',
        );
      }
      audit('testing_confirmation_resumed', { runId: run.runId, approved: true });
      return this.driveCoding(run, 'approve');
    }

    const storedInput = run.resumeInput;
    const storedToolId = pending.toolId;
    const confirmationId = pending.confirmationId;
    const resumePhase = run.resumeState;
    run.resumeState = null;
    run.resumeInput = null;

    if (decision === 'reject') {
      // The Tool System is the single authority: record the rejection there.
      this.tools.confirm(confirmationId, 'rejected');
      audit('testing_confirmation_resumed', { runId: run.runId, approved: false });
      return this.failRun(
        run,
        'TESTING_TEST_FAILED',
        `a human rejected the pending ${storedToolId} confirmation`,
      );
    }
    // The Tool System is the single authority: approve there FIRST, then
    // re-submit the exact stored input bound to that confirmation.
    this.tools.confirm(confirmationId, 'approved');
    audit('testing_confirmation_resumed', { runId: run.runId, approved: true });
    const result = await this.invokeTool(run, storedToolId, storedInput, confirmationId);
    if (result === null) return this.view(run); // paused again (defensive)
    if (storedToolId === TOOL_SANDBOX_EXECUTE) {
      // Return to the drive phase the confirmation paused before the result
      // is processed (running / retesting).
      if (resumePhase === 'running' || resumePhase === 'retesting') {
        run.state = transition(run.state, resumePhase);
      }
      const command = run.resolvedCommands[run.commandCursor] as TestCommand;
      run.commandsExecuted += 1;
      const recorded = this.recordCommandResult(run, command, result);
      audit('testing_command_executed', {
        runId: run.runId,
        pass: run.pass,
        label: command.label,
        purpose: command.purpose,
        success: recorded.success,
        exitCode: recorded.exitCode,
      });
      run.commandCursor += 1;
      run.updatedAt = this.now();
      if (!recorded.success) {
        return this.finishPassWithFailure(run, recorded);
      }
      return this.drivePass(run);
    }
    if (storedToolId === TOOL_SANDBOX_CREATE) {
      if (resumePhase === 'running' || resumePhase === 'retesting') {
        run.state = transition(run.state, resumePhase);
      }
      if (result.status !== 'success') {
        return this.failRun(run, 'TESTING_TOOL_ERROR', 'sandbox creation failed', {
          toolId: TOOL_SANDBOX_CREATE,
        });
      }
      const sandboxId = ((result.output ?? {}) as { sandboxId?: unknown }).sandboxId;
      if (typeof sandboxId !== 'string' || sandboxId.length === 0) {
        return this.failRun(run, 'TESTING_TOOL_ERROR', 'sandbox creation returned no id');
      }
      run.sandboxId = sandboxId;
      return this.drivePass(run);
    }
    // A paused low-risk read during planning or analysis: re-drive the phase
    // (detection and analysis are idempotent; nothing was mutated).
    const resumeState = run.resumeState ?? run.state;
    if (resumeState === 'planning') {
      // Defensive-only path (low-risk reads never force a confirmation in
      // practice): re-enter planning directly and re-detect. Detection is
      // idempotent and mutated nothing.
      run.state = 'planning';
      return this.phaseDetectAndPlan(run);
    }
    return this.view(run);
  }

  // ---- helpers ---------------------------------------------------------------

  /** Reads + parses the manifest through the Tool System (untrusted data). */
  private async readManifest(run: ManagedRun): Promise<ManifestRead> {
    const read = await this.invokeTool(run, TOOL_PROJECT_READ_FILE, {
      workspaceId: run.workspaceId,
      path: MANIFEST_PATH,
    });
    if (read === null) {
      return { paused: true, failed: false, manifest: null, bytes: null, message: '' };
    }
    if (read.status !== 'success') {
      return {
        paused: false,
        failed: true,
        manifest: null,
        bytes: null,
        message: 'the package manifest could not be read',
      };
    }
    const output = (read.output ?? {}) as { content?: unknown };
    if (typeof output.content !== 'string') {
      return {
        paused: false,
        failed: true,
        manifest: null,
        bytes: null,
        message: 'the package manifest read returned no content',
      };
    }
    const bytes = output.content.length;
    if (bytes > MAX_MANIFEST_BYTES) {
      return { paused: false, failed: false, manifest: null, bytes, message: '' };
    }
    try {
      return {
        paused: false,
        failed: false,
        manifest: JSON.parse(output.content),
        bytes,
        message: '',
      };
    } catch {
      return { paused: false, failed: false, manifest: null, bytes, message: '' };
    }
  }

  /** Normalizes one sandbox execution into a structured, scrubbed result. */
  private recordCommandResult(
    run: ManagedRun,
    command: TestCommand,
    result: ToolInvocationResult,
  ): TestCommandResult {
    // The tool output is UNTRUSTED DATA: shape-checked field by field, never
    // executed, bounded, and secret-shaped material is scrubbed.
    const output = (result.output ?? {}) as Record<string, unknown>;
    const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;
    const executionStatus = typeof output.status === 'string' ? output.status : null;
    const timedOut = output.timedOut === true;
    const terminated = output.terminated === true;
    const stdout = typeof output.stdout === 'string' ? output.stdout : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr : '';
    // A command "succeeded" only when the tool call itself succeeded AND the
    // sandbox execution completed with a zero exit code. Anything else
    // (non-zero exit, limit termination, timeout, tool failure) is a failure.
    const success =
      result.status === 'success' &&
      executionStatus === 'completed' &&
      exitCode === 0 &&
      !timedOut &&
      !terminated;
    const recorded: TestCommandResult = {
      index: run.passResults.length,
      label: command.label,
      purpose: command.purpose,
      command: { executable: command.executable, arguments: [...command.arguments] },
      executed: result.status === 'success',
      success,
      exitCode,
      timedOut,
      terminated,
      stdoutSummary: summarizeUntrustedOutput(stdout, 600),
      stderrSummary: summarizeUntrustedOutput(
        result.status === 'success'
          ? stderr
          : ((result as { error?: { message?: string } }).error?.message ?? stderr),
        600,
      ),
    };
    run.passResults.push(recorded);
    return recorded;
  }

  /** Typed terminal failure. Views keep the diagnosis + honest cause. */
  private failRun(
    run: ManagedRun,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): TestRunView {
    const audit = this.auditFor(run);
    if (isTestRunTerminal(run.state)) return this.view(run);
    const previous = run.state;
    run.pendingApproval = null;
    run.resumeState = null;
    run.resumeInput = null;
    run.failure = {
      code,
      message: scrubTestingSecrets(message),
      ...(details === undefined ? {} : { details }),
    };
    try {
      run.state = transition(run.state, 'failed');
    } catch {
      // A failure must always be reachable from any non-terminal state; if a
      // transition is missing that is a state-machine bug worth surfacing.
      run.state = 'failed';
    }
    run.updatedAt = this.now();
    audit('testing_run_failed', { runId: run.runId, code, from: previous });
    return this.view(run);
  }

  private run(runId: string): ManagedRun {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      throw new TestingError('TESTING_RUN_NOT_FOUND', `no test run "${runId}"`, {
        details: { runId },
      });
    }
    return entry;
  }

  private auditFor(
    run: ManagedRun,
  ): (type: TestAuditEventType, data: Record<string, unknown>) => void {
    return bindTestAudit(run.runId, this.now, this.auditSink);
  }

  // ---- safe views -------------------------------------------------------------

  private planView(plan: TestPlan): TestPlanView {
    return {
      version: plan.version,
      projectType: plan.projectType,
      framework: plan.detection.framework,
      runtime: plan.detection.runtime,
      signals: plan.detection.signals,
      validationSteps: plan.validationSteps,
      commands: plan.commands.map((command) => ({
        label: command.label,
        purpose: command.purpose,
        executable: command.executable,
        arguments: [...command.arguments],
        scriptName: command.scriptName ?? null,
      })),
      commandTimeoutMs: plan.commandTimeoutMs,
      repairAllowed: plan.repairAllowed,
      notes: plan.notes,
    };
  }

  private repairPlanView(plan: RepairPlan): RepairPlanView {
    return {
      summary: plan.diagnosis.summary,
      category: plan.diagnosis.category,
      confidence: plan.diagnosis.confidence,
      affectedPaths: plan.diagnosis.affectedPaths,
      changes: plan.changes.map((change) => ({
        path: change.path,
        mode: change.mode,
        reason: change.reason,
        expectedEffect: change.expectedEffect,
        contentBytes: change.content.length,
      })),
      risk: plan.risk,
      scope: plan.scope,
      verificationPlan: plan.verificationPlan,
      testsToRerun: plan.testsToRerun,
    };
  }

  private view(run: ManagedRun): TestRunView {
    return {
      runId: run.runId,
      state: run.state,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      projectType: run.plan?.projectType ?? null,
      plan: run.plan === null ? null : this.planView(run.plan),
      results: run.results,
      retestResults: run.retestResults,
      diagnosis: run.diagnosis,
      repairPlan: run.repairPlan === null ? null : this.repairPlanView(run.repairPlan),
      repairAttempts: run.repairAttempts,
      commandsExecuted: run.commandsExecuted,
      codingRunId: run.codingRunId,
      revisionConflict: run.revisionConflict,
      pendingApproval: run.pendingApproval,
      failure: run.failure,
      notes: [...run.notes],
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }
}

/** Extracts bounded node views from a list-files result. */
function extractNodes(result: ToolInvocationResult): readonly FileNodeView[] {
  const nodes = ((result.output ?? {}) as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const views: FileNodeView[] = [];
  for (const node of nodes.slice(0, 500)) {
    const path = (node as { path?: unknown }).path;
    const type = (node as { type?: unknown }).type;
    if (typeof path === 'string' && (type === 'file' || type === 'directory')) {
      views.push({ path, type });
    }
  }
  return views;
}

/**
 * The default repair runner: one fresh CodingAgentManager per repair, driven
 * by the deterministic RepairDecisionSource. The coding manager owns
 * revision discipline, forced confirmations, secret rejection, limits, and
 * audit - this runner grants nothing and executes nothing itself.
 */
function defaultCodingRepairRunner(options: TestingManagerOptions): CodingRepairRunner {
  return (input) => {
    const runId = `${input.runId}_repair_${Math.random().toString(36).slice(2, 8)}`;
    const coding = new CodingAgentManager({
      tools: options.tools,
      decisionSource: createRepairDecisionSource({
        repairPlan: input.repairPlan,
        runLabel: `test-run repair ${input.runId}`,
      }),
      ...(options.now !== undefined ? { now: options.now } : {}),
      generateRunId: () => runId,
    });
    return {
      async start() {
        return coding.startRun({
          runId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          userRequirement: 'Apply the approved repair plan',
          targetFiles: input.repairPlan.changes.map((change) => change.path),
          constraints: ['change only the approved files'],
          acceptanceCriteria: [input.repairPlan.verificationPlan],
        });
      },
      getRun() {
        return coding.getRun(runId);
      },
      async submitApproval(decision) {
        return coding.submitApproval(runId, decision);
      },
      cancel() {
        return coding.cancelRun(runId);
      },
    };
  };
}

/**
 * AppGenerationManager: creates, plans, approves, drives, inspects, and
 * cancels app-generation runs.
 *
 * The pipeline is BOUNDED and OBSERVABLE:
 *
 *   idea -> specification -> plan -> HUMAN approval -> initialize ->
 *   generate -> validate -> test -> (bounded repair loop) -> result
 *
 * Every project file mutation and every sandbox command flows through the
 * Tool System - this manager never touches the host filesystem, a shell,
 * the environment, credentials, or a provider SDK. Project + workspace
 * creation uses the existing Project Engine directly (trusted server-side
 * bootstrap, part of the human-approved plan, audited).
 *
 * Generated file content is UNTRUSTED DATA throughout: it is validated
 * (secret-shaped content rejected), written through the Tool System, and
 * never treated as instructions, policy, or authority.
 */

import type { ToolInvocationResult, ToolManager } from '@veltravia/tool-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { ProjectType } from '@veltravia/project-core';

import {
  bindGenerationAudit,
  type GenerationAuditSink,
  type GenerationAuditEventType,
} from '../audit/index.js';
import { GenerationError, isGenerationError, scrubGenerationSecrets } from '../errors/index.js';
import type { GenerationPlanner } from '../planner/index.js';
import {
  resolveGenerationLimits,
  selectTemplate,
  validateRepairProposal,
  validateAppSpecification,
  validateGenerationPlan,
  validateIdea,
} from '../policy/index.js';
import type { RepairSource } from '../repair/index.js';
import { transition } from '../state/index.js';
import { isGenerationTerminal } from '../types/index.js';
import { TemplateRegistry, createDefaultTemplateRegistry } from '../templates/index.js';
import type {
  AppSpecification,
  AppType,
  GenerationChangedFile,
  GenerationFailure,
  GenerationOutcome,
  GenerationPendingApproval,
  GenerationPhase,
  GenerationPhaseProgress,
  GenerationPhaseStatus,
  GenerationPlan,
  GenerationPlanView,
  GenerationResult,
  GenerationRunLimits,
  GenerationRunView,
  GenerationState,
  GenerationTestSummary,
  GenerationValidationSummary,
  PlannedFile,
  ProjectTemplate,
} from '../types/index.js';

/** The Tool System tool ids the engine binds to (code, never model choice). */
const TOOL_PROJECT_CREATE_FILE = 'project.create-file';
const TOOL_PROJECT_CREATE_DIRECTORY = 'project.create-directory';
const TOOL_PROJECT_UPDATE_FILE = 'project.update-file';
const TOOL_PROJECT_READ_FILE = 'project.read-file';
const TOOL_SANDBOX_CREATE = 'sandbox.create';
const TOOL_SANDBOX_EXECUTE = 'sandbox.execute';

const PHASE_ORDER: readonly GenerationPhase[] = [
  'planning',
  'initialize',
  'generate',
  'validate',
  'test',
  'repair',
];

function projectTypeForAppType(appType: AppType): ProjectType {
  switch (appType) {
    case 'web':
      return 'web';
    case 'fullstack':
      return 'fullstack';
    case 'backend-api':
      return 'backend';
  }
}

interface ManagedRun {
  readonly runId: string;
  readonly idea: string;
  readonly createdAt: Date;
  state: GenerationState;
  spec: AppSpecification | null;
  plan: GenerationPlan | null;
  template: ProjectTemplate | null;
  projectId: string | null;
  workspaceId: string | null;
  changedFiles: Map<string, 'created' | 'updated'>;
  phaseStatus: Map<GenerationPhase, GenerationPhaseStatus>;
  failedPhase: GenerationPhase | null;
  validation: GenerationValidationSummary | null;
  tests: GenerationTestSummary | null;
  testCommands: GenerationTestSummary['commands'];
  repairAttempts: number;
  warnings: string[];
  remainingIssues: string[];
  failure: GenerationFailure | null;
  result: GenerationResult | null;
  pendingApproval: GenerationPendingApproval | null;
  resumeState: GenerationState | null;
  sandboxId: string | null;
  fileWrites: number;
  commandRuns: number;
  generateIndex: number;
  commandIndex: number;
  createdDirectories: Set<string>;
  cancelled: boolean;
  updatedAt: Date;
}

export interface AppGenerationManagerOptions {
  /** The Tool System - the ONLY path to project files and the sandbox. */
  readonly tools: ToolManager;
  /** The existing Project & Workspace Engine (project bootstrap). */
  readonly projectEngine: ProjectEngine;
  /** Idea -> specification + plan (AI-routed or deterministic mock). */
  readonly planner: GenerationPlanner;
  /** Bounded repair proposals on validation/test failure. */
  readonly repairSource: RepairSource;
  /** Deterministic templates; defaults to the built-in registry. */
  readonly registry?: TemplateRegistry;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** Injectable run-id generator. */
  readonly generateRunId?: () => string;
  /** Audit sink (bounded metadata only). */
  readonly onAudit?: (event: unknown) => void;
  /** Trusted server-side limit overrides (capped by hard ceilings). */
  readonly limits?: Partial<GenerationRunLimits>;
  /** Project owner identity (metadata, never a credential). */
  readonly ownerRef?: string;
}

export class AppGenerationManager {
  private readonly runs = new Map<string, ManagedRun>();
  /** Stored pending inputs for confirmation resumes (input-bound). */
  private readonly resumeInputs = new Map<string, Record<string, unknown>>();
  private readonly limits: GenerationRunLimits;
  private readonly registry: TemplateRegistry;
  private readonly ownerRef: string;
  private readonly now: () => Date;
  private readonly generateRunId: () => string;
  private readonly audit: (
    runId: string,
  ) => (type: GenerationAuditEventType, details?: Record<string, unknown>) => void;

  constructor(private readonly options: AppGenerationManagerOptions) {
    this.limits = resolveGenerationLimits(options.limits);
    this.registry = options.registry ?? createDefaultTemplateRegistry();
    this.ownerRef = options.ownerRef ?? 'veltravia-dev-user';
    this.now = options.now ?? (() => new Date());
    this.generateRunId =
      options.generateRunId ?? (() => `gen_${Math.random().toString(36).slice(2, 12)}`);
    this.audit = bindGenerationAudit(options.onAudit as GenerationAuditSink | undefined, this.now);
  }

  // ---------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------

  /**
   * Creates a run from a natural-language idea and drives it through
   * planning up to `awaiting_approval`. NO project mutation happens here:
   * material mutations only start after explicit human plan approval.
   */
  async startRun(input: {
    readonly idea: string;
    readonly runId?: string;
  }): Promise<GenerationRunView> {
    const idea = validateIdea(input.idea);
    const runId = input.runId ?? this.generateRunId();
    if (this.runs.has(runId)) {
      throw new GenerationError('GENERATION_INVALID_REQUEST', `run "${runId}" already exists`, {
        runId,
      });
    }
    const now = this.now();
    const run: ManagedRun = {
      runId,
      idea,
      createdAt: now,
      state: 'created',
      spec: null,
      plan: null,
      template: null,
      projectId: null,
      workspaceId: null,
      changedFiles: new Map(),
      phaseStatus: new Map(PHASE_ORDER.map((phase) => [phase, 'pending' as GenerationPhaseStatus])),
      failedPhase: null,
      validation: null,
      tests: null,
      testCommands: [],
      repairAttempts: 0,
      warnings: [],
      remainingIssues: [],
      failure: null,
      result: null,
      pendingApproval: null,
      resumeState: null,
      sandboxId: null,
      fileWrites: 0,
      commandRuns: 0,
      generateIndex: 0,
      commandIndex: 0,
      createdDirectories: new Set<string>(),
      cancelled: false,
      updatedAt: now,
    };
    this.runs.set(runId, run);
    const audit = this.auditFor(run.runId);
    audit('generation_run_created', { runId });

    run.state = transition(run.state, 'planning');
    run.phaseStatus.set('planning', 'in_progress');
    run.updatedAt = this.now();
    audit('generation_phase_started', { runId, phase: 'planning' });

    try {
      const { spec, plan } = await this.options.planner.plan(idea);
      // Planner output is DATA: the same strict validation that would apply
      // to real model output applies here. Raw output is never trusted.
      const validatedSpec = validateAppSpecification(spec);
      const template = selectTemplate(validatedSpec, this.registry.list());
      const validatedPlan = validateGenerationPlan(plan, validatedSpec, template, this.limits);
      run.spec = validatedSpec;
      run.plan = validatedPlan;
      run.template = template;
      run.phaseStatus.set('planning', 'done');
      run.state = transition(run.state, 'awaiting_approval');
      run.pendingApproval = { kind: 'plan_approval' };
      run.updatedAt = this.now();
      audit('generation_plan_ready', { runId, templateId: template.id });
    } catch (error) {
      return this.failRun(
        run,
        'GENERATION_PLANNER_ERROR',
        this.plannerFailureMessage(error),
        'planning',
      );
    }
    return this.view(run);
  }

  getRun(runId: string): GenerationRunView {
    return this.view(this.run(runId));
  }

  /** The safe plan view (paths, sizes, dependencies, commands, risk - no dumps). */
  getPlan(runId: string): GenerationPlanView {
    const run = this.run(runId);
    if (run.plan === null) {
      throw new GenerationError('GENERATION_APPROVAL_REQUIRED', `run "${runId}" has no plan yet`, {
        runId,
      });
    }
    const plan = run.plan;
    return {
      version: plan.version,
      project: plan.project,
      templateId: plan.templateId,
      filesToCreate: plan.filesToCreate.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8'),
      })),
      filesToModify: plan.filesToModify.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8'),
      })),
      dependencies: plan.dependencies,
      commands: plan.commands,
      risk: plan.risk,
    };
  }

  /** The terminal result (or an honest error when the run is not terminal). */
  getResult(runId: string): GenerationResult {
    const run = this.run(runId);
    if (!isGenerationTerminal(run.state) || run.result === null) {
      throw new GenerationError(
        'GENERATION_APPROVAL_REQUIRED',
        `run "${runId}" has not finished yet`,
        { runId, state: run.state },
      );
    }
    return run.result;
  }

  /**
   * Submits a human decision for a paused run: plan approval or a Tool
   * System tool confirmation. The engine never approves itself.
   */
  async submitApproval(runId: string, decision: 'approve' | 'reject'): Promise<GenerationRunView> {
    const run = this.run(runId);
    if (isGenerationTerminal(run.state)) {
      throw new GenerationError('GENERATION_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        runId,
        state: run.state,
      });
    }
    if (run.state !== 'awaiting_approval' || run.pendingApproval === null) {
      throw new GenerationError(
        'GENERATION_NOT_AWAITING_APPROVAL',
        `run "${runId}" has no pending approval`,
        { runId, state: run.state },
      );
    }
    const audit = this.auditFor(run.runId);
    const pending = run.pendingApproval;

    if (pending.kind === 'plan_approval') {
      run.pendingApproval = null;
      run.resumeState = null;
      if (decision === 'reject') {
        audit('generation_plan_rejected', { runId });
        return this.failRun(
          run,
          'GENERATION_PLAN_REJECTED',
          'the generation plan was rejected by a human',
          'planning',
        );
      }
      audit('generation_plan_approved', { runId });
      run.state = transition(run.state, 'initializing');
      run.phaseStatus.set('initialize', 'in_progress');
      run.updatedAt = this.now();
      audit('generation_phase_started', { runId, phase: 'initialize' });
      return this.drive(run);
    }

    // Tool confirmation: the Tool System's Step 5 mechanism is the single
    // authority - single-use, input-bound, expiring.
    run.pendingApproval = null;
    this.options.tools.confirm(
      pending.confirmationId,
      decision === 'approve' ? 'approved' : 'rejected',
    );
    if (decision === 'reject') {
      audit('generation_tool_denied', { runId, toolId: pending.toolId, reason: 'human rejected' });
      return this.failRun(
        run,
        'GENERATION_CANCELLED',
        'a human rejected the required tool confirmation',
        run.failedPhase,
      );
    }
    const resumeInput = this.resumeInputs.get(run.runId);
    this.resumeInputs.delete(run.runId);
    if (resumeInput === undefined) {
      return this.failRun(
        run,
        'GENERATION_CANCELLED',
        'the confirmation expired before it was approved',
        run.failedPhase,
      );
    }
    const resumeState = run.resumeState ?? run.state;
    run.state = run.state === 'awaiting_approval' ? resumeState : run.state;
    run.updatedAt = this.now();
    const result = await this.invokeTool(run, pending.toolId, resumeInput, pending.confirmationId);
    if (result === null) {
      return this.view(run); // paused again for another confirmation
    }
    if (result.status !== 'success') {
      return this.handleToolFailure(run, pending.toolId, result);
    }
    if (pending.toolId === TOOL_SANDBOX_EXECUTE && run.plan !== null) {
      // The confirmed command's outcome is recorded exactly once; the phase
      // loop resumes at the NEXT command and never re-runs the confirmed one.
      run.commandRuns += 1;
      const command = run.plan.commands[run.commandIndex];
      if (command !== undefined) {
        const passed = this.recordCommandResult(run, command, result);
        if (!passed) {
          run.remainingIssues = [`command "${command.command}" reported a failure`];
          run.tests = { executed: true, commands: [...run.testCommands] };
          return this.enterRepair(run, 'test');
        }
      }
    }
    audit('generation_tool_executed', { runId, toolId: pending.toolId, resumed: true });
    return this.drive(run);
  }

  /**
   * Cancels a run. Cancellation is one-way: it marks the run cancelled,
   * stops future work, and audits the event. It never claims to undo
   * already-completed mutations.
   */
  async cancelRun(runId: string): Promise<GenerationRunView> {
    const run = this.run(runId);
    if (isGenerationTerminal(run.state)) {
      throw new GenerationError('GENERATION_RUN_TERMINAL', `run "${runId}" is already terminal`, {
        runId,
        state: run.state,
      });
    }
    const audit = this.auditFor(run.runId);
    run.cancelled = true;
    run.pendingApproval = null;
    this.resumeInputs.delete(run.runId);
    run.state = transition(run.state, 'cancelled');
    run.updatedAt = this.now();
    audit('generation_run_cancelled', { runId, previousPending: 'cleared' });
    run.result = this.buildResult(run, 'cancelled');
    return this.view(run);
  }

  // ---------------------------------------------------------------------
  // Phase driver
  // ---------------------------------------------------------------------

  private async drive(run: ManagedRun): Promise<GenerationRunView> {
    if (run.cancelled || isGenerationTerminal(run.state)) {
      return this.view(run);
    }
    this.assertDuration(run);

    switch (run.state) {
      case 'initializing':
        return this.phaseInitialize(run);
      case 'generating':
        return this.phaseGenerate(run);
      case 'validating':
        return this.phaseValidate(run);
      case 'testing':
        return this.phaseTest(run);
      case 'repairing':
        return this.phaseRepair(run);
      default:
        return this.view(run);
    }
  }

  /** Phase 1 - Initialize: project + workspace via the existing engine. */
  private async phaseInitialize(run: ManagedRun): Promise<GenerationRunView> {
    const audit = this.auditFor(run.runId);
    const plan = run.plan;
    const spec = run.spec;
    if (plan === null || spec === null) {
      return this.failRun(run, 'GENERATION_PLANNER_ERROR', 'run lost its plan', 'initialize');
    }
    try {
      const project = await this.options.projectEngine.projects.createProject({
        name: plan.project.name,
        description: plan.project.description,
        projectType: projectTypeForAppType(spec.appType),
        ownerRef: this.ownerRef,
      });
      const workspace = await this.options.projectEngine.workspaces.createWorkspace(project.id, {
        name: 'Generated Workspace',
      });
      run.projectId = project.id;
      run.workspaceId = workspace.id;
      run.updatedAt = this.now();
      audit('generation_phase_completed', { runId: run.runId, phase: 'initialize' });
    } catch (error) {
      return this.failRun(
        run,
        'GENERATION_PROJECT_CONFLICT',
        scrubGenerationSecrets(error instanceof Error ? error.message : 'project creation failed'),
        'initialize',
      );
    }
    run.state = transition(run.state, 'generating');
    run.phaseStatus.set('initialize', 'done');
    run.phaseStatus.set('generate', 'in_progress');
    run.updatedAt = this.now();
    this.auditFor(run.runId)('generation_phase_started', { runId: run.runId, phase: 'generate' });
    return this.drive(run);
  }

  /** Phase 2 - Generate: every file through the Tool System. */
  private async phaseGenerate(run: ManagedRun): Promise<GenerationRunView> {
    const plan = run.plan;
    if (plan === null || run.workspaceId === null) {
      return this.failRun(
        run,
        'GENERATION_PLANNER_ERROR',
        'run lost its plan or workspace',
        'generate',
      );
    }
    const audit = this.auditFor(run.runId);
    while (run.generateIndex < plan.filesToCreate.length) {
      if (run.cancelled) return this.view(run);
      if (run.fileWrites >= this.limits.maxFilesChanged) {
        return this.failRun(run, 'GENERATION_FILE_LIMIT', 'file-change limit reached', 'generate');
      }
      const file = plan.filesToCreate[run.generateIndex] as PlannedFile;
      // Nested files need their parent directories first. Each ancestor is
      // created through the SAME Tool System pipeline; a PATH_CONFLICT means
      // the directory already exists and is skipped idempotently.
      const ensured = await this.ensureParentDirectories(run, file.path);
      if (ensured === null) return this.view(run); // paused for confirmation
      if (ensured === false) {
        return this.failRun(
          run,
          'GENERATION_PLANNER_ERROR',
          `could not create the parent directories for "${file.path}"`,
          'generate',
        );
      }
      const result = await this.invokeTool(run, TOOL_PROJECT_CREATE_FILE, {
        workspaceId: run.workspaceId,
        path: file.path,
        content: file.content,
      });
      if (result === null) {
        return this.view(run); // paused for a confirmation
      }
      if (result.status !== 'success') {
        audit('generation_tool_denied', {
          runId: run.runId,
          toolId: TOOL_PROJECT_CREATE_FILE,
          path: file.path,
        });
        return this.handleToolFailure(run, TOOL_PROJECT_CREATE_FILE, result, 'generate');
      }
      run.fileWrites += 1;
      run.changedFiles.set(file.path, 'created');
      run.generateIndex += 1;
      run.updatedAt = this.now();
      audit('generation_tool_executed', {
        runId: run.runId,
        toolId: TOOL_PROJECT_CREATE_FILE,
        path: file.path,
      });
    }
    audit('generation_phase_completed', { runId: run.runId, phase: 'generate' });
    run.state = transition(run.state, 'validating');
    run.phaseStatus.set('generate', 'done');
    run.phaseStatus.set('validate', 'in_progress');
    run.updatedAt = this.now();
    audit('generation_phase_started', { runId: run.runId, phase: 'validate' });
    return this.drive(run);
  }

  /** Phase 3 - Validate: template structure rules, no execution. */
  private async phaseValidate(run: ManagedRun): Promise<GenerationRunView> {
    const template = run.template;
    if (template === null || run.workspaceId === null) {
      return this.failRun(
        run,
        'GENERATION_PLANNER_ERROR',
        'run lost its template or workspace',
        'validate',
      );
    }
    const audit = this.auditFor(run.runId);
    const checks: { description: string; passed: boolean }[] = [];
    for (const requiredPath of template.validationRules.requiredFiles) {
      if (run.cancelled) return this.view(run);
      const result = await this.invokeTool(run, TOOL_PROJECT_READ_FILE, {
        workspaceId: run.workspaceId,
        path: requiredPath,
      });
      if (result === null) return this.view(run);
      const passed = result.status === 'success';
      checks.push({ description: `required file "${requiredPath}" exists`, passed });
      if (
        passed &&
        template.validationRules.packageManifestRequired &&
        requiredPath === 'package.json'
      ) {
        const output = (result.output ?? {}) as { content?: unknown };
        let parses = false;
        if (typeof output.content === 'string') {
          try {
            const parsed = JSON.parse(output.content) as unknown;
            parses = parsed !== null && typeof parsed === 'object';
          } catch {
            parses = false;
          }
        }
        checks.push({ description: 'package.json is a parseable manifest', passed: parses });
      }
    }
    const summary: GenerationValidationSummary = {
      passed: checks.every((check) => check.passed),
      checks,
    };
    run.validation = summary;
    run.updatedAt = this.now();
    if (!summary.passed) {
      run.remainingIssues = checks
        .filter((check) => !check.passed)
        .map((check) => check.description);
      audit('generation_phase_completed', { runId: run.runId, phase: 'validate', passed: false });
      return this.enterRepair(run, 'validate');
    }
    audit('generation_phase_completed', { runId: run.runId, phase: 'validate', passed: true });
    run.state = transition(run.state, 'testing');
    run.phaseStatus.set('validate', 'done');
    run.phaseStatus.set('test', 'in_progress');
    run.updatedAt = this.now();
    audit('generation_phase_started', { runId: run.runId, phase: 'test' });
    return this.drive(run);
  }

  /** Phase 4 - Test: structured commands in the sandbox, results verified. */
  private async phaseTest(run: ManagedRun): Promise<GenerationRunView> {
    const plan = run.plan;
    if (plan === null || run.workspaceId === null) {
      return this.failRun(
        run,
        'GENERATION_PLANNER_ERROR',
        'run lost its plan or workspace',
        'test',
      );
    }
    const audit = this.auditFor(run.runId);
    if (run.sandboxId === null) {
      const created = await this.invokeTool(run, TOOL_SANDBOX_CREATE, {
        workspaceRef: run.workspaceId,
      });
      if (created === null) return this.view(run); // paused for confirmation
      if (created.status !== 'success') {
        return this.handleToolFailure(run, TOOL_SANDBOX_CREATE, created, 'test');
      }
      run.sandboxId = ((created.output ?? {}) as { sandboxId?: unknown }).sandboxId as string;
      run.updatedAt = this.now();
    }
    while (run.commandIndex < plan.commands.length) {
      if (run.cancelled) return this.view(run);
      if (run.commandRuns >= this.limits.maxCommands) {
        return this.failRun(run, 'GENERATION_COMMAND_LIMIT', 'command limit reached', 'test');
      }
      const command = plan.commands[run.commandIndex] as NonNullable<
        GenerationPlan['commands'][number]
      >;
      const result = await this.invokeTool(run, TOOL_SANDBOX_EXECUTE, {
        sandboxId: run.sandboxId,
        command: command.command,
        arguments: [...command.arguments],
      });
      if (result === null) return this.view(run); // paused for confirmation
      run.commandRuns += 1;
      const recorded = this.recordCommandResult(run, command, result);
      run.updatedAt = this.now();
      audit('generation_tool_executed', {
        runId: run.runId,
        toolId: TOOL_SANDBOX_EXECUTE,
        purpose: command.purpose,
        passed: recorded,
      });
      if (!recorded) {
        run.remainingIssues = [`command "${command.command}" reported a failure`];
        run.tests = { executed: true, commands: [...run.testCommands] };
        return this.enterRepair(run, 'test');
      }
    }
    run.tests = { executed: true, commands: [...run.testCommands] };
    audit('generation_phase_completed', { runId: run.runId, phase: 'test', passed: true });
    return this.completeRun(run);
  }

  /** Phase 5 - Repair: bounded loop with a hard maximum. Never infinite. */
  private async phaseRepair(run: ManagedRun): Promise<GenerationRunView> {
    const audit = this.auditFor(run.runId);
    if (run.repairAttempts >= this.limits.maxRepairAttempts) {
      return this.failRun(
        run,
        'GENERATION_REPAIR_LIMIT',
        `repair limit reached (${this.limits.maxRepairAttempts} attempts)`,
        'repair',
      );
    }
    const spec = run.spec;
    const plan = run.plan;
    if (spec === null || plan === null || run.workspaceId === null) {
      return this.failRun(
        run,
        'GENERATION_PLANNER_ERROR',
        'run lost its plan or workspace',
        'repair',
      );
    }
    let proposal;
    try {
      proposal = await this.options.repairSource.proposeFixes({
        runId: run.runId,
        attempt: run.repairAttempts + 1,
        spec,
        plan,
        failures: [...run.remainingIssues],
        untrustedFiles: [],
      });
    } catch (error) {
      return this.failRun(
        run,
        'GENERATION_VALIDATION_FAILED',
        scrubGenerationSecrets(error instanceof Error ? error.message : 'repair source failed'),
        'repair',
      );
    }
    if (proposal.filesToWrite.length === 0) {
      // The repair source declines honestly - no silent infinite loop.
      return this.failRun(
        run,
        'GENERATION_VALIDATION_FAILED',
        'the repair source proposed no fixes',
        'repair',
      );
    }
    let repairFiles: readonly PlannedFile[];
    try {
      repairFiles = validateRepairProposal(proposal.filesToWrite);
    } catch (error) {
      return this.failRun(
        run,
        'GENERATION_VALIDATION_FAILED',
        error instanceof Error ? error.message : 'the repair proposal was rejected',
        'repair',
      );
    }
    for (const file of repairFiles) {
      if (run.cancelled) return this.view(run);
      if (run.fileWrites >= this.limits.maxFilesChanged) {
        return this.failRun(run, 'GENERATION_FILE_LIMIT', 'file-change limit reached', 'repair');
      }
      const written = await this.writeThroughTools(run, file);
      if (written === null) return this.view(run); // paused
      if (!written) {
        return this.failRun(
          run,
          'GENERATION_VALIDATION_FAILED',
          `repair write failed for "${file.path}"`,
          'repair',
        );
      }
      run.fileWrites += 1;
      run.updatedAt = this.now();
    }
    run.repairAttempts += 1;
    audit('generation_repair_attempted', {
      runId: run.runId,
      attempt: run.repairAttempts,
      files: proposal.filesToWrite.map((file) => file.path),
    });
    run.warnings.push(`repair attempt ${run.repairAttempts}: ${proposal.description}`);
    run.remainingIssues = [];
    run.state = transition(run.state, 'validating');
    run.phaseStatus.set('repair', 'done');
    run.phaseStatus.set('validate', 'in_progress');
    run.updatedAt = this.now();
    audit('generation_phase_started', { runId: run.runId, phase: 'validate' });
    return this.drive(run);
  }

  /** Writes one file (create or update) purely through the Tool System. */
  private async writeThroughTools(run: ManagedRun, file: PlannedFile): Promise<boolean | null> {
    if (run.workspaceId === null) return false;
    const existing = await this.invokeTool(run, TOOL_PROJECT_READ_FILE, {
      workspaceId: run.workspaceId,
      path: file.path,
    });
    if (existing === null) return null;
    if (existing.status === 'success') {
      const revision = ((existing.output ?? {}) as { revision?: unknown }).revision;
      const updated = await this.invokeTool(run, TOOL_PROJECT_UPDATE_FILE, {
        workspaceId: run.workspaceId,
        path: file.path,
        content: file.content,
        expectedRevision: typeof revision === 'number' ? revision : -1,
      });
      if (updated === null) return null;
      if (updated.status !== 'success') return false;
      run.changedFiles.set(file.path, 'updated');
      return true;
    }
    const created = await this.invokeTool(run, TOOL_PROJECT_CREATE_FILE, {
      workspaceId: run.workspaceId,
      path: file.path,
      content: file.content,
    });
    if (created === null) return null;
    if (created.status !== 'success') return false;
    run.changedFiles.set(file.path, 'created');
    return true;
  }

  private async enterRepair(
    run: ManagedRun,
    failedPhase: 'validate' | 'test',
  ): Promise<GenerationRunView> {
    const audit = this.auditFor(run.runId);
    run.failedPhase = failedPhase;
    if (run.repairAttempts >= this.limits.maxRepairAttempts) {
      return this.failRun(
        run,
        'GENERATION_REPAIR_LIMIT',
        `repair limit reached (${this.limits.maxRepairAttempts} attempts)`,
        failedPhase,
      );
    }
    if (failedPhase === 'test') {
      run.phaseStatus.set('test', 'failed');
    } else {
      run.phaseStatus.set('validate', 'failed');
    }
    run.state = transition(run.state, 'repairing');
    run.phaseStatus.set('repair', 'in_progress');
    run.updatedAt = this.now();
    audit('generation_phase_started', { runId: run.runId, phase: 'repair' });
    return this.drive(run);
  }

  // ---------------------------------------------------------------------
  // Tool invocation (the Tool System is the only execution authority)
  // ---------------------------------------------------------------------

  private async invokeTool(
    run: ManagedRun,
    toolId: string,
    input: Record<string, unknown>,
    confirmationId?: string,
  ): Promise<ToolInvocationResult | null> {
    const result = await this.options.tools.invoke(toolId, input, {
      requester: 'app-generation',
      correlationId: run.runId,
      ...(confirmationId !== undefined ? { confirmationId } : {}),
    });
    const audit = this.auditFor(run.runId);
    if (result.status === 'awaiting_confirmation' && result.confirmationId !== undefined) {
      run.pendingApproval = {
        kind: 'tool_confirmation',
        toolId,
        confirmationId: result.confirmationId,
      };
      run.resumeState = run.state;
      this.resumeInputs.set(run.runId, input);
      run.state = transition(run.state, 'awaiting_approval');
      run.updatedAt = this.now();
      audit('generation_confirmation_requested', {
        runId: run.runId,
        toolId,
        confirmationId: result.confirmationId,
      });
      return null;
    }
    return result;
  }

  private handleToolFailure(
    run: ManagedRun,
    toolId: string,
    result: ToolInvocationResult,
    phase?: GenerationPhase | null,
  ): GenerationRunView {
    const error = result.error;
    const code =
      error?.code === 'PATH_CONFLICT' ||
      (result as { error?: { details?: { cause?: string } } }).error?.details?.cause ===
        'PATH_CONFLICT'
        ? 'GENERATION_PROJECT_CONFLICT'
        : 'GENERATION_PLANNER_ERROR';
    return this.failRun(
      run,
      code,
      scrubGenerationSecrets(error?.message ?? `tool "${toolId}" failed`),
      phase,
    );
  }

  // ---------------------------------------------------------------------
  // Terminal helpers
  // ---------------------------------------------------------------------

  /**
   * Creates every missing ancestor directory of a file path through the
   * Tool System. Returns true when the chain is ready, false on failure,
   * and null when a tool paused for human confirmation. A PATH_CONFLICT is
   * an existing directory - idempotent success, never an error.
   */
  private async ensureParentDirectories(
    run: ManagedRun,
    filePath: string,
  ): Promise<boolean | null> {
    if (run.workspaceId === null) return false;
    const segments = filePath.split('/');
    if (segments.length <= 1) return true; // root-level file
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      if (run.createdDirectories.has(directory)) continue;
      const result = await this.invokeTool(run, TOOL_PROJECT_CREATE_DIRECTORY, {
        workspaceId: run.workspaceId,
        path: directory,
      });
      if (result === null) return null; // paused
      if (result.status === 'success') {
        run.createdDirectories.add(directory);
        continue;
      }
      const error = (result.error ?? {}) as {
        code?: string;
        details?: { cause?: string; path?: string };
        message?: string;
      };
      const isConflict =
        error.details?.cause === 'PATH_CONFLICT' ||
        (error.message?.includes('already exists') ?? false);
      if (isConflict) {
        run.createdDirectories.add(directory);
        continue;
      }
      return false;
    }
    return true;
  }

  /**
   * Records one sandbox command result (bounded, scrubbed excerpts only).
   * Returns true when the command passed. UNTRUSTED DATA throughout.
   */
  private recordCommandResult(
    run: ManagedRun,
    command: NonNullable<GenerationPlan['commands'][number]>,
    result: ToolInvocationResult,
  ): boolean {
    const output = (result.output ?? {}) as {
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const stdout = typeof output.stdout === 'string' ? output.stdout.slice(0, 2000) : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr.slice(0, 2000) : '';
    const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;
    const passed = result.status === 'success' && exitCode === 0;
    run.testCommands = [
      ...run.testCommands,
      {
        command: command.command,
        arguments: [...command.arguments],
        exitCode,
        passed,
        stdout,
        stderr,
      },
    ];
    run.commandIndex += 1;
    return passed;
  }

  private completeRun(run: ManagedRun): GenerationRunView {
    const audit = this.auditFor(run.runId);
    run.phaseStatus.set('test', 'done');
    if (run.repairAttempts === 0) run.phaseStatus.set('repair', 'skipped');
    run.state = transition(run.state, 'completed');
    const outcome: GenerationOutcome =
      run.repairAttempts > 0 || run.warnings.length > 0 ? 'completed_with_warnings' : 'completed';
    run.result = this.buildResult(run, outcome);
    run.updatedAt = this.now();
    audit('generation_run_completed', { runId: run.runId, outcome });
    return this.view(run);
  }

  private failRun(
    run: ManagedRun,
    code: string,
    message: string,
    phase?: GenerationPhase | null,
  ): GenerationRunView {
    const audit = this.auditFor(run.runId);
    run.failure = { code, message: scrubGenerationSecrets(message) };
    run.remainingIssues = run.remainingIssues.length > 0 ? run.remainingIssues : [message];
    if (phase !== null && phase !== undefined) {
      run.failedPhase = phase;
      const current = run.phaseStatus.get(phase);
      if (current === 'in_progress') run.phaseStatus.set(phase, 'failed');
    }
    if (run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'completed') {
      run.state = transition(run.state, 'failed');
    }
    run.result = this.buildResult(run, 'failed');
    run.updatedAt = this.now();
    audit('generation_run_failed', { runId: run.runId, code });
    return this.view(run);
  }

  private buildResult(run: ManagedRun, outcome: GenerationOutcome): GenerationResult {
    return {
      outcome,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      filesChanged: [...run.changedFiles.entries()].map(
        ([path, action]): GenerationChangedFile => ({ path, action }),
      ),
      validation: run.validation,
      tests: run.tests,
      repairAttempts: run.repairAttempts,
      warnings: [...run.warnings],
      remainingIssues:
        outcome === 'completed' ? [] : [...new Set(run.remainingIssues)].slice(0, 20),
      completedAt: this.now().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Guards + views
  // ---------------------------------------------------------------------

  private assertDuration(run: ManagedRun): void {
    const elapsed = this.now().getTime() - run.createdAt.getTime();
    if (elapsed > this.limits.maxDurationMs) {
      this.failRun(run, 'GENERATION_DURATION_LIMIT', 'generation duration limit reached');
      throw new GenerationError('GENERATION_DURATION_LIMIT', 'generation duration limit reached', {
        runId: run.runId,
      });
    }
  }

  private run(runId: string): ManagedRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new GenerationError('GENERATION_RUN_NOT_FOUND', `run "${runId}" not found`, { runId });
    }
    return run;
  }

  private plannerFailureMessage(error: unknown): string {
    if (isGenerationError(error)) return error.message;
    return scrubGenerationSecrets(
      error instanceof Error ? error.message : 'the planner could not produce a plan',
    );
  }

  private auditFor(
    runId: string,
  ): (type: GenerationAuditEventType, details?: Record<string, unknown>) => void {
    return this.audit(runId);
  }

  private view(run: ManagedRun): GenerationRunView {
    const phases: GenerationPhaseProgress[] = PHASE_ORDER.map((phase) => ({
      phase,
      status: run.phaseStatus.get(phase) ?? 'pending',
    }));
    return {
      runId: run.runId,
      idea: run.idea,
      state: run.state,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      templateId: run.template?.id ?? null,
      specName: run.spec?.name ?? null,
      appType: run.spec?.appType ?? null,
      phases,
      changedFiles: [...run.changedFiles.entries()].map(
        ([path, action]): GenerationChangedFile => ({ path, action }),
      ),
      repairAttempts: run.repairAttempts,
      failure: run.failure,
      pendingApproval: run.pendingApproval,
      result: run.result,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }
}

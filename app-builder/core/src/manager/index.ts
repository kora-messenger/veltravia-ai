/**
 * The App Builder manager (Step 30).
 *
 * Owns the orchestration only: specifications go to the validator, manifests go
 * to the detector, plans come from the generator, and WRITES go through the
 * project port. It never writes a file itself, never runs a command, and never
 * decides that a technology is supported.
 *
 * Every stored plan is owner-scoped. A plan belonging to another owner answers
 * "not found", the same as a plan that never existed, so existence stays private.
 */

import { AppBuilderError } from '../errors/index.js';
import { TechnologyStackDetector } from '../detect/index.js';
import { buildScaffoldPlan } from '../generate/index.js';
import type { LanguageFrameworkRegistry } from '../registry/index.js';
import { compareRequestedStack, validateProjectSpecification } from '../spec/index.js';
import type {
  AppBuilderCapabilities,
  BuildMilestone,
  ManifestFile,
  ProjectSpecification,
  ScaffoldPlan,
  SpecificationReview,
  RegistryEntry,
  StackDetection,
} from '../types/index.js';
import type {
  CodingAgentPort,
  CodingSessionResult,
  DeploymentPort,
  PreviewPort,
  ProjectFilesPort,
  SandboxPort,
} from '../ports/index.js';

const MAX_PLANS_PER_OWNER = 50;
const MAX_AUDIT_EVENTS = 500;

export interface AppBuilderPorts {
  readonly projects: ProjectFilesPort;
  readonly sandbox: SandboxPort;
  readonly codingAgent: CodingAgentPort;
  readonly preview: PreviewPort;
  readonly deployment: DeploymentPort;
}

export interface AppBuilderManagerOptions {
  readonly registry: LanguageFrameworkRegistry;
  readonly ports: AppBuilderPorts;
  readonly now?: () => string;
  readonly generateId?: () => string;
}

export interface AuditEvent {
  readonly at: string;
  readonly ownerRef: string;
  readonly action: string;
  readonly outcome: 'ok' | 'refused';
  readonly detail: string;
}

export interface MaterializeResult {
  readonly planId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly createdFiles: readonly string[];
  readonly createdDirectories: readonly string[];
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Directories implied by a set of file paths, parents first. */
export function deriveDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      if (directory.length > 0) directories.add(directory);
    }
  }
  return [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
}

export class AppBuilderManager {
  private readonly registry: LanguageFrameworkRegistry;
  private readonly detector: TechnologyStackDetector;
  private readonly ports: AppBuilderPorts;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly plans = new Map<string, ScaffoldPlan>();
  private readonly auditLog: AuditEvent[] = [];

  constructor(options: AppBuilderManagerOptions) {
    this.registry = options.registry;
    this.detector = new TechnologyStackDetector(options.registry);
    this.ports = options.ports;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? (() => randomId('plan'));
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  capabilities(): AppBuilderCapabilities {
    const entries = this.registry.list();
    const scaffold = entries
      .filter((entry) => entry.supportLevel === 'scaffold')
      .map((entry) => entry.id);
    const planned = entries
      .filter((entry) => entry.supportLevel === 'planned')
      .map((entry) => entry.id);

    return {
      registryVersion: this.registry.catalogVersion,
      supported: [
        'project specification validation',
        'technology stack detection',
        'deterministic scaffold plans',
        'materializing a scaffold into a project workspace',
        'owner-scoped projects, plans and audit trail',
        'handing work to the coding agent',
      ],
      partial: [
        `scaffolding exists for: ${scaffold.join(', ')}`,
        'the preview and deployment ports are modelled but not implemented',
        'build and test commands are declared, never executed',
      ],
      notSupported: [
        'running a real build or test (the sandbox engine is simulated)',
        'deploying a project anywhere',
        `execution support for: ${planned.join(', ')}`,
        'device emulation for mobile projects',
      ],
      limits: {
        maxFiles: 80,
        maxFileBytes: 200_000,
        maxSpecificationBytes: 32_000,
      },
      milestones: MILESTONES,
    };
  }

  /** Every catalog entry, for the review surface. */
  listTechnologies(): readonly RegistryEntry[] {
    return this.registry.list();
  }

  /** One entry by id; an unknown id is a typed not-found error. */
  getTechnology(id: string): RegistryEntry {
    return this.registry.get(id);
  }

  // -------------------------------------------------------------------------
  // Specification
  // -------------------------------------------------------------------------

  reviewSpecification(specification: unknown): SpecificationReview {
    return validateProjectSpecification(specification, this.registry);
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  detectFromManifest(files: readonly ManifestFile[]): StackDetection {
    return this.detector.detect(files);
  }

  /** Detects the stack of an existing workspace through the project port. */
  async detectWorkspace(input: {
    readonly workspaceId: string;
    readonly projectId?: string;
  }): Promise<StackDetection> {
    if (input.projectId !== undefined) {
      const belongs = await this.ports.projects.workspaceBelongsToProject(
        input.workspaceId,
        input.projectId,
      );
      if (!belongs) {
        throw new AppBuilderError(
          'APP_BUILDER_WORKSPACE_NOT_FOUND',
          'That workspace is not part of the project you asked about.',
        );
      }
    }

    const paths = await this.ports.projects.listFilePaths(input.workspaceId);
    const manifests: ManifestFile[] = [];
    for (const path of paths.slice(0, 2_000)) {
      const text = await this.ports.projects.readFileText(input.workspaceId, path, 40_000);
      manifests.push(text === undefined ? { path } : { path, text });
    }
    return this.detector.detect(manifests);
  }

  /** Reports a stack difference without ever changing the specification. */
  compareStack(
    specification: ProjectSpecification,
    detection: StackDetection,
  ): ReturnType<typeof compareRequestedStack> {
    return compareRequestedStack(specification, detection, this.registry);
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  createPlan(input: {
    readonly ownerRef: string;
    readonly specification: unknown;
    readonly projectId?: string | null;
  }): ScaffoldPlan {
    const existing = [...this.plans.values()].filter((plan) => plan.ownerRef === input.ownerRef);
    if (existing.length >= MAX_PLANS_PER_OWNER) {
      throw new AppBuilderError(
        'APP_BUILDER_LIMIT_EXCEEDED',
        'You have reached the number of plans this surface keeps. Materialize or discard one first.',
      );
    }

    const plan = buildScaffoldPlan(
      {
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? null,
        specification: input.specification,
        planId: this.generateId(),
        now: this.now(),
      },
      this.registry,
    );

    this.plans.set(plan.id, plan);
    this.record(input.ownerRef, 'plan.create', 'ok', `planned ${plan.files.length} files`);
    return plan;
  }

  listPlans(ownerRef: string): readonly ScaffoldPlan[] {
    return [...this.plans.values()]
      .filter((plan) => plan.ownerRef === ownerRef)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Owner-scoped fetch: a foreign plan is indistinguishable from a missing one. */
  getPlan(ownerRef: string, planId: string): ScaffoldPlan {
    const plan = this.plans.get(planId);
    if (plan === undefined || plan.ownerRef !== ownerRef) {
      throw new AppBuilderError('APP_BUILDER_PLAN_NOT_FOUND', 'That plan does not exist.');
    }
    return plan;
  }

  // -------------------------------------------------------------------------
  // Materialization (the only place that writes)
  // -------------------------------------------------------------------------

  async materializePlan(input: {
    readonly ownerRef: string;
    readonly planId: string;
    readonly projectId?: string | null;
  }): Promise<MaterializeResult> {
    const plan = this.getPlan(input.ownerRef, input.planId);
    if (plan.status === 'materialized') {
      throw new AppBuilderError(
        'APP_BUILDER_PLAN_ALREADY_MATERIALIZED',
        'That plan was already turned into a project. Create a new plan instead of writing twice.',
      );
    }

    const spec = plan.specification;
    let projectId: string;
    let workspaceId: string;

    try {
      const ensured = await this.ports.projects.ensureProject({
        ownerRef: input.ownerRef,
        name: spec.name,
        description: spec.description,
        projectKind: spec.projectKind,
      });
      projectId = ensured.projectId;
      workspaceId = ensured.workspaceId;
    } catch (error) {
      this.record(input.ownerRef, 'plan.materialize', 'refused', 'project could not be created');
      throw error instanceof AppBuilderError
        ? error
        : new AppBuilderError(
            'APP_BUILDER_MATERIALIZE_FAILED',
            'The project could not be created.',
          );
    }

    const createdDirectories: string[] = [];
    const createdFiles: string[] = [];

    try {
      for (const directory of deriveDirectories(plan.files.map((file) => file.path))) {
        await this.ports.projects.createDirectory(workspaceId, directory);
        createdDirectories.push(directory);
      }
      for (const file of plan.files) {
        await this.ports.projects.createFile(workspaceId, file.path, file.content);
        createdFiles.push(file.path);
      }
    } catch (error) {
      // A half-written project is worse than a clear failure: say what exists.
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.record(
        input.ownerRef,
        'plan.materialize',
        'refused',
        `stopped after ${createdFiles.length} files`,
      );
      throw new AppBuilderError(
        'APP_BUILDER_MATERIALIZE_FAILED',
        `The scaffold stopped after ${createdFiles.length} of ${plan.files.length} files (${reason}). The project exists with partial files; review before continuing.`,
        { createdFiles, createdDirectories },
      );
    }

    const materialized: ScaffoldPlan = {
      ...plan,
      status: 'materialized',
      projectId: projectId ?? null,
    };
    this.plans.set(plan.id, materialized);
    this.record(input.ownerRef, 'plan.materialize', 'ok', `wrote ${createdFiles.length} files`);

    return {
      planId: plan.id,
      projectId: projectId ?? '',
      workspaceId,
      createdFiles,
      createdDirectories,
    };
  }

  // -------------------------------------------------------------------------
  // Delegation to existing subsystems
  // -------------------------------------------------------------------------

  /** Build/test execution, which this release honestly refuses. */
  async buildStatus(): Promise<{ available: boolean; reason: string }> {
    return { available: this.ports.sandbox.available, reason: this.ports.sandbox.reason };
  }

  async runBuild(input: {
    readonly ownerRef: string;
    readonly planId: string;
  }): Promise<{ ran: boolean; reason: string }> {
    const plan = this.getPlan(input.ownerRef, input.planId);
    if (!this.ports.sandbox.available) {
      return { ran: false, reason: this.ports.sandbox.reason };
    }
    if (plan.buildCommand === null) {
      return { ran: false, reason: 'This stack declares no build command.' };
    }
    return { ran: false, reason: 'Build execution is not enabled in this release.' };
  }

  async requestPreview(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId: string;
  }): Promise<Awaited<ReturnType<PreviewPort['request']>>> {
    return this.ports.preview.request(input);
  }

  async deploy(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly target: string;
  }): Promise<Awaited<ReturnType<DeploymentPort['deploy']>>> {
    return this.ports.deployment.deploy(input);
  }

  /** Hands the workspace to the existing coding agent; no bespoke loop here. */
  async startCodingSession(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly instruction: string;
  }): Promise<CodingSessionResult> {
    if (typeof input.instruction !== 'string' || input.instruction.trim().length === 0) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        'Describe what the coding agent should do.',
      );
    }
    if (input.instruction.length > 20_000) {
      throw new AppBuilderError('APP_BUILDER_LIMIT_EXCEEDED', 'That instruction is too long.');
    }
    this.record(input.ownerRef, 'coding.session', 'ok', 'handed to the coding agent');
    return this.ports.codingAgent.startSession(input);
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  audit(ownerRef: string): readonly AuditEvent[] {
    return this.auditLog.filter((event) => event.ownerRef === ownerRef).slice(-100);
  }

  private record(
    ownerRef: string,
    action: string,
    outcome: AuditEvent['outcome'],
    detail: string,
  ): void {
    this.auditLog.push({ at: this.now(), ownerRef, action, outcome, detail });
    if (this.auditLog.length > MAX_AUDIT_EVENTS) this.auditLog.shift();
  }
}

/**
 * The product vision, with the honest state of each piece. Served to clients so
 * the UI never has to guess what works.
 */
export const MILESTONES: readonly BuildMilestone[] = [
  {
    id: 'specification',
    title: 'Project specification',
    state: 'done',
    detail:
      'Strict, language-independent specification with validation, secret rejection and stack resolution.',
  },
  {
    id: 'registry',
    title: 'Language and framework registry',
    state: 'done',
    detail:
      'Extensible catalog with versions, package managers, commands, runtime, preview and deployment facts.',
  },
  {
    id: 'detection',
    title: 'Stack detection',
    state: 'done',
    detail:
      'Evidence-weighted detection from file names and manifests; never rewrites the requested stack.',
  },
  {
    id: 'scaffold',
    title: 'Scaffold generation',
    state: 'partial',
    detail:
      'Deterministic starter files for HTML, React, Node/Fastify, Python, Go, Dart/Flutter and plain JS/TS. Other languages are named, not generated.',
  },
  {
    id: 'materialize',
    title: 'Writing into a real project',
    state: 'done',
    detail:
      'Plans are written into a real project workspace through the existing project engine, with directories created first.',
  },
  {
    id: 'build-test',
    title: 'Build and test orchestration',
    state: 'planned',
    detail:
      'Commands are declared per technology and validated, but nothing executes while the sandbox is simulated.',
  },
  {
    id: 'preview',
    title: 'Live preview',
    state: 'planned',
    detail:
      'The preview port exists and is wired to the runtime engine in the API; no runtime is started by the builder yet.',
  },
  {
    id: 'deploy',
    title: 'Deployment',
    state: 'planned',
    detail:
      'No deployment provider is enabled. The port exists so one can be added without touching the builder.',
  },
  {
    id: 'mobile',
    title: 'Mobile experience',
    state: 'partial',
    detail: 'The same API and accounts serve a mobile client; the web shell is responsive today.',
  },
];

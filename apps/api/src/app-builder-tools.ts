import {
  AppBuilderError,
  type AppBuilderManager,
  type CommandPlan,
  type DetectedTechnology,
  type RegistryEntry,
  type ScaffoldPlan,
  type StackDetection,
} from '@veltravia/app-builder-core';
import type { ProjectEngine } from '@veltravia/project-core';
import {
  defineObjectSchema,
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';

/**
 * App Builder tools for the assistant, in two groups.
 *
 * Reading (createAppBuilderTools): list the technologies the builder knows,
 * look one up, check a project specification, and detect the stack of a
 * workspace the caller owns. None of these writes a file or starts anything.
 *
 * Acting (createAppBuilderActionTools): plan, create a project from a plan,
 * hand work to the coding agent, build, preview and deploy. Everything that
 * changes a project or starts work needs a person's approval of the exact
 * input, enforced by the Tool System, so the assistant proposes and a person
 * decides. Build and deploy report what this release really supports.
 *
 * Ownership is enforced here, not trusted from the model: the owner is bound
 * by the server when the tool manager is created, and a workspace is only read
 * after the project it names is confirmed to belong to that owner.
 */

export const APP_BUILDER_TOOL_IDS = [
  'appbuilder.capabilities',
  'appbuilder.technology',
  'appbuilder.check_spec',
  'appbuilder.detect_stack',
] as const;

/**
 * The acting tools. Every one of these is granted, and every one except
 * create_plan also demands a person's approval before it runs.
 */
export const APP_BUILDER_ACTION_TOOL_IDS = [
  'appbuilder.create_plan',
  'appbuilder.create_project_from_plan',
  'appbuilder.start_coding_session',
  'appbuilder.run_build',
  'appbuilder.request_preview',
  'appbuilder.deploy',
] as const;

const idSchema = (description: string) =>
  ({ type: 'string', description, minLength: 1, maxLength: 128 }) as const;

const str = (description: string) => ({ type: 'string', description }) as const;
const strList = (description: string) =>
  ({ type: 'array', description, items: { type: 'string', description } }) as const;

/** The project specification, shared by the check and the plan tools. */
const specificationSchema = {
  type: 'object',
  description:
    'The project specification to check. name and projectKind are required; the check reports them if missing. apis, build, runtime and deployment are not accepted here; check those on the App Builder page.',
  properties: {
    name: str('Project name.'),
    description: str('What the project is.'),
    projectKind: str('web, mobile, backend, fullstack, library or other.'),
    frontend: str('Catalog id of the frontend technology.'),
    backend: str('Catalog id of the backend technology.'),
    mobile: str('Catalog id of the mobile technology.'),
    additionalLanguages: strList('Extra catalog language ids.'),
    dependencies: strList('Dependency names.'),
    environment: strList('Environment variable NAMES only, never values.'),
    constraints: strList('Free-form constraints, treated as data.'),
    database: {
      type: 'object',
      description: 'Database requirement.',
      properties: {
        engine: str('postgres, mysql, sqlite, mongodb, firestore or none.'),
        tooling: str('ORM or migration tooling.'),
        migrations: { type: 'boolean', description: 'Whether migrations are needed.' },
      },
      additionalProperties: false,
    },
    authentication: {
      type: 'object',
      description: 'Authentication requirement.',
      properties: {
        strategy: str('none, email-password, oauth, sso, api-key or passkeys.'),
        providers: strList('Provider names.'),
        notes: str('Anything else.'),
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const technologyShape = {
  type: 'object',
  description: 'One language or framework from the catalog.',
  properties: {
    id: str('Catalog id.'),
    name: str('Display name.'),
    kind: str('language or framework.'),
    layer: str('Which layer it belongs to.'),
    supportLevel: str('How far the platform supports it today: scaffold or planned.'),
    unsupported: strList('Things the platform does NOT do for this technology.'),
    previewNote: str('What preview, if any, is possible.'),
    deploymentNote: str('Which deployment targets it could use.'),
  },
  required: ['id', 'name', 'kind', 'layer', 'supportLevel', 'unsupported'],
  additionalProperties: false,
} as const;

const detectedShape = {
  type: 'object',
  description: 'A technology found in the workspace.',
  properties: {
    id: str('Catalog id.'),
    name: str('Display name.'),
    kind: str('language or framework.'),
    confidence: { type: 'number', description: 'How much of the evidence points here, 0 to 1.' },
    supportLevel: str('scaffold or planned.'),
    evidence: strList('Up to five signals that led to this, as "signal: detail".'),
  },
  required: ['id', 'name', 'kind', 'confidence', 'supportLevel', 'evidence'],
  additionalProperties: false,
} as const;

const issueShape = {
  type: 'object',
  description: 'One problem found in a specification.',
  properties: {
    path: str('Where in the specification.'),
    code: str('Machine-readable code.'),
    message: str('What is wrong.'),
    severity: str('error blocks execution; warning is advisory.'),
  },
  required: ['path', 'code', 'message', 'severity'],
  additionalProperties: false,
} as const;

const MAX_ITEMS = 40;

const technologyOf = (entry: RegistryEntry) => ({
  id: String(entry.id),
  name: String(entry.name),
  kind: String(entry.kind),
  layer: String(entry.layer),
  supportLevel: String(entry.supportLevel),
  unsupported: entry.unsupported.slice(0, MAX_ITEMS).map(String),
  previewNote: String(entry.preview.note),
  deploymentNote: String(entry.deployment.note),
});

const detectedOf = (item: DetectedTechnology) => ({
  id: String(item.id),
  name: String(item.name),
  kind: String(item.kind),
  confidence: Number(item.confidence),
  supportLevel: String(item.supportLevel),
  evidence: item.evidence
    .slice(0, 5)
    .map((e) => `${String(e.signal)}: ${String(e.detail)}`.slice(0, 200)),
});

export function createAppBuilderTools(
  appBuilder: AppBuilderManager,
  projects: ProjectEngine,
  ownerRef: string,
): { definitions: ToolDefinition[]; implementations: ToolImplementation[] } {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];

  const add = (
    definition: ToolDefinition,
    handler: (input: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ): void => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input) => {
        try {
          return await handler(input);
        } catch (error) {
          if (error instanceof ToolExecutionError) throw error;
          const code = (error as { code?: unknown }).code;
          const message = error instanceof Error ? error.message : 'The App Builder refused that.';
          throw new ToolExecutionError(definition.id, message, {
            details: { cause: typeof code === 'string' ? code : 'APP_BUILDER_ERROR' },
          });
        }
      },
    });
  };

  add(
    defineTool({
      id: 'appbuilder.capabilities',
      name: 'App Builder capabilities',
      description:
        'Says what the App Builder can do today and which languages and frameworks it supports, planned or scaffold-ready. Use it before promising a stack.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          plannedOnly: {
            type: 'boolean',
            description:
              'When true, return only the technologies that are planned, not yet scaffold-ready.',
          },
        },
        required: [],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          registryVersion: str('Catalog version.'),
          supported: strList('What the builder does today.'),
          partial: strList('What works only in part.'),
          notSupported: strList('What the builder does NOT do. Say so rather than promising it.'),
          scaffoldReady: strList('Technology ids that can be scaffolded today.'),
          planned: strList('Technology ids that are planned but not executable.'),
        },
        required: ['registryVersion', 'supported', 'partial', 'notSupported'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const c = appBuilder.capabilities();
      // `planned` and `scaffoldReady` are not on capabilities(); they come from
      // the catalog's own support levels, so they cannot drift from it.
      const catalog = appBuilder.listTechnologies();
      const idsAt = (level: string) =>
        catalog
          .filter((entry) => entry.supportLevel === level)
          .slice(0, MAX_ITEMS)
          .map((entry) => entry.id);
      const planned = idsAt('planned');
      const base = { registryVersion: String(c.registryVersion), planned };
      if (input['plannedOnly'] === true) {
        return { ...base, supported: [], partial: [], notSupported: [], scaffoldReady: [] };
      }
      return {
        ...base,
        supported: c.supported.slice(0, MAX_ITEMS).map(String),
        partial: c.partial.slice(0, MAX_ITEMS).map(String),
        notSupported: c.notSupported.slice(0, MAX_ITEMS).map(String),
        scaffoldReady: idsAt('scaffold'),
      };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.technology',
      name: 'Look up a technology',
      description:
        'Returns one language or framework from the builder catalog by id, including how far its support goes.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: { technologyId: idSchema('Catalog id, for example "react" or "python".') },
        required: ['technologyId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: { technology: technologyShape },
        required: ['technology'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => ({
      technology: technologyOf(appBuilder.getTechnology(String(input['technologyId']))),
    }),
  );

  add(
    defineTool({
      id: 'appbuilder.check_spec',
      name: 'Check a project specification',
      description:
        'Validates a project specification and reports problems and warnings. Nothing is created or saved.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          specification: specificationSchema,
        },
        required: ['specification'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          valid: { type: 'boolean', description: 'True when nothing blocks the specification.' },
          supportLevel: str('The lowest support level in the stack: what it can really do.'),
          issues: { type: 'array', description: 'Problems and warnings.', items: issueShape },
          unsupported: strList('Technologies requested that the platform cannot serve yet.'),
        },
        required: ['valid', 'supportLevel', 'issues', 'unsupported'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const review = appBuilder.reviewSpecification(input['specification']);
      return {
        valid: Boolean(review.valid),
        supportLevel: String(review.supportLevel),
        issues: review.issues.slice(0, MAX_ITEMS).map((i) => ({
          path: String(i.path),
          code: String(i.code),
          message: String(i.message).slice(0, 300),
          severity: String(i.severity),
        })),
        unsupported: review.unsupported
          .slice(0, MAX_ITEMS)
          .map((u) => `${String(u.id)}: ${String(u.reason)}`.slice(0, 300)),
      };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.detect_stack',
      name: 'Detect a workspace stack',
      description:
        'Reads the file list and manifests of one of the owner\u2019s project workspaces and reports the languages and frameworks it finds, with the evidence. Changes nothing.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          projectId: idSchema('Project id.'),
          workspaceId: idSchema('Workspace id inside that project.'),
        },
        required: ['projectId', 'workspaceId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          languages: { type: 'array', description: 'Languages found.', items: detectedShape },
          frameworks: { type: 'array', description: 'Frameworks found.', items: detectedShape },
          unrecognisedFiles: { type: 'number', description: 'Files that gave no signal.' },
          unknownLanguages: strList('Languages present that the catalog has no entry for.'),
          notes: strList('Anything the detector wants you to know.'),
        },
        required: ['languages', 'frameworks', 'unrecognisedFiles', 'unknownLanguages', 'notes'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const projectId = String(input['projectId']);
      const workspaceId = String(input['workspaceId']);
      const project = await projects.projects.getProject(projectId);
      // Same answer for "no such project" and "someone else's project", so the
      // tool cannot be used to find out which project ids exist.
      if (project.ownerRef !== ownerRef || project.status !== 'active') {
        throw new ToolExecutionError('appbuilder.detect_stack', 'That project was not found.', {
          details: { cause: 'PROJECT_NOT_FOUND' },
        });
      }
      const d: StackDetection = await appBuilder.detectWorkspace({ projectId, workspaceId });
      return {
        languages: d.languages.slice(0, MAX_ITEMS).map(detectedOf),
        frameworks: d.frameworks.slice(0, MAX_ITEMS).map(detectedOf),
        unrecognisedFiles: d.unrecognisedFiles,
        unknownLanguages: d.unknownLanguages.slice(0, MAX_ITEMS).map(String),
        notes: d.notes.slice(0, MAX_ITEMS).map((n) => String(n).slice(0, 300)),
      };
    },
  );

  return { definitions, implementations };
}

/**
 * The App Builder tools that act: plan, create a project, hand work to the
 * coding agent, build, preview and deploy.
 *
 * What each one really does today, so no tool promises more than it delivers:
 *
 * - `create_plan` builds a reviewable plan in memory and writes nothing.
 * - `create_project_from_plan` writes the plan's files into a project. It needs
 *   a person's approval of the exact input before it runs.
 * - `start_coding_session` hands a written instruction to the coding agent,
 *   which keeps its own plan-approval gate. It also needs approval.
 * - `run_build`, `request_preview` and `deploy` call the real manager and relay
 *   its answer. This release has a simulated sandbox and no deployment provider,
 *   so they report that plainly. They never claim a build or a deployment that
 *   did not happen.
 *
 * Ownership is bound by the server, never supplied by the model, and a project
 * is read only after it is confirmed to belong to that owner.
 */
export function createAppBuilderActionTools(
  appBuilder: AppBuilderManager,
  projects: ProjectEngine,
  ownerRef: string,
): { definitions: ToolDefinition[]; implementations: ToolImplementation[] } {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];

  const add = (
    definition: ToolDefinition,
    handler: (input: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ): void => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input) => {
        try {
          return await handler(input);
        } catch (error) {
          if (error instanceof ToolExecutionError) throw error;
          // The builder's own errors are written for people; anything else is
          // not echoed, so an internal message never reaches the model.
          const known = error instanceof AppBuilderError;
          throw new ToolExecutionError(
            definition.id,
            known ? error.message : 'The App Builder could not do that.',
            { details: { cause: known ? error.code : 'APP_BUILDER_FAILED' } },
          );
        }
      },
    });
  };

  const text = (input: Readonly<Record<string, unknown>>, key: string): string => {
    const value = input[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ToolExecutionError('appbuilder', `${key} is required.`);
    }
    return value;
  };

  /** Confirms the project is the caller's, or fails as if it did not exist. */
  const ownedProject = async (toolId: string, projectId: string): Promise<void> => {
    const owned = await projects.projects
      .getProject(projectId)
      .then((project) => project.ownerRef === ownerRef && project.status === 'active')
      // A missing project and someone else's project must look the same.
      .catch(() => false);
    if (!owned) {
      throw new ToolExecutionError(toolId, 'That project was not found.', {
        details: { cause: 'PROJECT_NOT_FOUND' },
      });
    }
  };

  const planShape = {
    type: 'object',
    description: 'A reviewable plan. File contents are not included, only what each file is for.',
    properties: {
      id: str('Plan id. Pass it to create_project_from_plan.'),
      status: str('planned, or materialized once it has been written.'),
      supportLevel: str('How far the chosen stack is supported.'),
      fileCount: { type: 'number', description: 'How many files the plan would write.' },
      files: {
        type: 'array',
        description: 'Each planned file and what it is for (capped).',
        items: {
          type: 'object',
          description: 'One planned file.',
          properties: { path: str('Path.'), description: str('What it is for.') },
          additionalProperties: false,
        },
      },
      buildCommand: str('The build command the stack declares, or empty. It is never run here.'),
      testCommand: str('The test command the stack declares, or empty. It is never run here.'),
      previewNote: str('What preview the stack could offer.'),
      notes: strList('Notes from the specification check.'),
    },
    additionalProperties: false,
  } as const;

  /** A command for display only. It is an argv list and is never run from here. */
  const commandText = (command: CommandPlan | null): string =>
    command === null ? '' : command.argv.join(' ').slice(0, 300);

  const planOf = (plan: ScaffoldPlan) => ({
    id: plan.id,
    status: plan.status,
    supportLevel: String(plan.review.supportLevel),
    fileCount: plan.files.length,
    files: plan.files
      .slice(0, 80)
      .map((file) => ({ path: file.path, description: file.description.slice(0, 200) })),
    buildCommand: commandText(plan.buildCommand),
    testCommand: commandText(plan.testCommand),
    previewNote: String(plan.preview.note).slice(0, 300),
    notes: plan.review.notes.slice(0, MAX_ITEMS).map((n) => String(n).slice(0, 300)),
  });

  add(
    defineTool({
      id: 'appbuilder.create_plan',
      name: 'Plan a new app',
      description:
        'Turns a project specification into a reviewable plan of starter files. Writes nothing: the plan only exists until it is turned into a project or discarded.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: { specification: specificationSchema },
        required: ['specification'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: { plan: planShape },
        required: ['plan'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.plan'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const plan = appBuilder.createPlan({ ownerRef, specification: input['specification'] });
      return { plan: planOf(plan) };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.create_project_from_plan',
      name: 'Create a project from a plan',
      description:
        'Writes a plan\u2019s starter files into a project in the owner\u2019s workspace. This changes the project, so a person must approve the exact input first. A plan can be written once.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: { planId: idSchema('The plan to write, from create_plan.') },
        required: ['planId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          projectId: str('The project the files were written to.'),
          workspaceId: str('The workspace holding them.'),
          filesCreated: { type: 'number', description: 'How many files were written.' },
          createdFiles: strList('Paths written (capped).'),
        },
        required: ['projectId', 'workspaceId', 'filesCreated'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.write'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    async (input) => {
      const result = await appBuilder.materializePlan({
        ownerRef,
        planId: text(input, 'planId'),
      });
      return {
        projectId: result.projectId,
        workspaceId: result.workspaceId,
        filesCreated: result.createdFiles.length,
        createdFiles: result.createdFiles.slice(0, 80),
      };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.start_coding_session',
      name: 'Hand work to the coding agent',
      description:
        'Gives a written instruction to the coding agent for one of the owner\u2019s project workspaces. The coding agent still shows its own plan and waits for approval before it changes a file. A person must approve this hand-off.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          projectId: idSchema('The project.'),
          workspaceId: idSchema('A workspace of that project.'),
          instruction: {
            type: 'string',
            description: 'What to build or change.',
            maxLength: 20000,
          },
        },
        required: ['projectId', 'workspaceId', 'instruction'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          runId: str('The coding run to follow.'),
          status: str('Where the run is.'),
        },
        required: ['runId', 'status'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.write'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    async (input) => {
      const projectId = text(input, 'projectId');
      await ownedProject('appbuilder.start_coding_session', projectId);
      const result = await appBuilder.startCodingSession({
        ownerRef,
        projectId,
        workspaceId: text(input, 'workspaceId'),
        instruction: text(input, 'instruction'),
      });
      return { runId: result.runId, status: result.status };
    },
  );

  const attemptShape = {
    ran: { type: 'boolean', description: 'True only if it really happened.' },
    reason: str('The real reason, in plain words.'),
  } as const;

  add(
    defineTool({
      id: 'appbuilder.run_build',
      name: 'Run a plan\u2019s build',
      description:
        'Asks the builder to run a plan\u2019s build command. In this release the sandbox is simulated, so it reports that no build ran and why. It never claims a build that did not happen.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: { planId: idSchema('The plan whose build to run.') },
        required: ['planId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: attemptShape,
        required: ['ran', 'reason'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.build'],
      riskLevel: 'medium',
      requiresConfirmation: true,
    }),
    async (input) => {
      const result = await appBuilder.runBuild({ ownerRef, planId: text(input, 'planId') });
      return { ran: result.ran, reason: result.reason.slice(0, 400) };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.request_preview',
      name: 'Request a preview',
      description:
        'Asks for a preview of one of the owner\u2019s project workspaces. Reports whether a preview exists and where, or why not.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          projectId: idSchema('The project.'),
          workspaceId: idSchema('A workspace of that project.'),
        },
        required: ['projectId', 'workspaceId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          available: { type: 'boolean', description: 'Whether a preview exists.' },
          mode: str('static, server, device-emulator or none.'),
          url: str('Where to see it, or empty.'),
          reason: str('The real reason, in plain words.'),
        },
        required: ['available', 'mode', 'reason'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.build'],
      riskLevel: 'medium',
      requiresConfirmation: true,
    }),
    async (input) => {
      const projectId = text(input, 'projectId');
      await ownedProject('appbuilder.request_preview', projectId);
      const result = await appBuilder.requestPreview({
        ownerRef,
        projectId,
        workspaceId: text(input, 'workspaceId'),
      });
      return {
        available: result.available,
        mode: result.mode,
        url: result.url ?? '',
        reason: result.reason.slice(0, 400),
      };
    },
  );

  add(
    defineTool({
      id: 'appbuilder.deploy',
      name: 'Deploy a project',
      description:
        'Asks the builder to deploy one of the owner\u2019s projects to a target. No deployment provider is enabled in this release, so it reports that nothing was deployed and why. A person must approve it, so that a provider enabled later cannot deploy silently.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          projectId: idSchema('The project to deploy.'),
          target: str('Where to deploy it, for example "staging".'),
        },
        required: ['projectId', 'target'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          started: { type: 'boolean', description: 'True only if a deployment really began.' },
          reason: str('The real reason, in plain words.'),
        },
        required: ['started', 'reason'],
        additionalProperties: false,
      }),
      requiredPermissions: ['appbuilder.deploy'],
      riskLevel: 'critical',
      requiresConfirmation: true,
    }),
    async (input) => {
      const projectId = text(input, 'projectId');
      await ownedProject('appbuilder.deploy', projectId);
      const result = await appBuilder.deploy({
        ownerRef,
        projectId,
        target: text(input, 'target'),
      });
      return { started: result.started, reason: result.reason.slice(0, 400) };
    },
  );

  return { definitions, implementations };
}

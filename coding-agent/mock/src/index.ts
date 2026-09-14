/**
 * @veltravia/coding-agent-mock - the offline, deterministic Coding Agent
 * environment. A scripted decision source drives the REAL Coding Agent loop,
 * against a REAL Tool System wired to the in-memory Project Engine and the
 * mock sandbox runtime. Nothing executes host code; nothing touches the
 * network, the host filesystem, or credentials.
 */

import {
  createProjectTools,
  type CodingDecision,
  type CodingDecisionContext,
  type CodingDecisionSource,
  CODING_TOOL_IDS,
} from '@veltravia/coding-agent-core';
import type { ProjectEngine } from '@veltravia/project-core';
import { createProjectEngine } from '@veltravia/project-mock';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';
import {
  defineObjectSchema,
  defineTool,
  ToolManager,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';
import { ConnectorManager } from '@veltravia/connector-core';
import {
  createFakeRepository,
  createGitHubConnectorRuntime,
  createGitHubOperationExecutor,
  createGitHubToolDefinitions,
  FakeGitHubTransport,
  GITHUB_CONNECTOR_ID,
} from '@veltravia/connector-github';

// ---------------------------------------------------------------------------
// Scripted decision source
// ---------------------------------------------------------------------------

export interface ScriptedCodingDecisionSourceOptions {
  /** Decisions returned in order. Exhausting the script fails deterministically. */
  readonly script: readonly CodingDecision[];
}

/**
 * A deterministic decision source: returns scripted decisions in order. It
 * never invents capabilities - unknown decision shapes are rejected by the
 * core exactly as unvalidated model output would be.
 */
export class ScriptedCodingDecisionSource implements CodingDecisionSource {
  private index = 0;

  constructor(options: ScriptedCodingDecisionSourceOptions) {
    this.script = [...options.script];
  }

  private readonly script: readonly CodingDecision[];

  nextDecision(_context: CodingDecisionContext): Promise<CodingDecision> {
    void _context;
    if (this.index >= this.script.length) {
      // Deterministic failure: an exhausted script never improvises.
      return Promise.resolve({ type: 'fail', reason: 'script exhausted' });
    }
    const decision = this.script[this.index] as CodingDecision;
    this.index += 1;
    return Promise.resolve(decision);
  }
}

export function createScriptedCodingDecisionSource(
  script: readonly CodingDecision[],
): ScriptedCodingDecisionSource {
  return new ScriptedCodingDecisionSource({ script });
}

// ---------------------------------------------------------------------------
// Fixture sandbox tools (mirror the Step 8 declarations; policy lives in the
// SandboxManager, so this is an adapter, not a second policy)
// ---------------------------------------------------------------------------

import type { ToolFieldSchema } from '@veltravia/tool-core';
const workspaceRefSchema: ToolFieldSchema = {
  type: 'string',
  description: 'Project Engine workspace id.',
  minLength: 1,
  maxLength: 128,
};

export function createFixtureSandboxTools(manager: SandboxManager): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const create: { definition: ToolDefinition; implementation: ToolImplementation } = {
    definition: defineTool({
      id: 'sandbox.create',
      name: 'Create Sandbox',
      description: 'Creates an isolated sandbox pinned to one project workspace.',
      version: '1.0.0',
      category: 'system',
      inputSchema: defineObjectSchema({
        properties: { workspaceRef: workspaceRefSchema },
        required: ['workspaceRef'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          sandboxId: { type: 'string', description: 'Created sandbox id.' },
          status: { type: 'string', description: 'Sandbox status.' },
          expiresAt: { type: 'string', description: 'ISO-8601 expiry time.' },
        },
        required: ['sandboxId', 'status', 'expiresAt'],
        additionalProperties: false,
      }),
      requiredPermissions: ['sandbox.create'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    implementation: {
      toolId: 'sandbox.create',
      handler: async (input) => {
        const sandbox = await manager.createSandbox({ workspaceRef: input.workspaceRef as string });
        return { sandboxId: sandbox.id, status: sandbox.status, expiresAt: sandbox.expiresAt };
      },
    },
  };

  const execute: { definition: ToolDefinition; implementation: ToolImplementation } = {
    definition: defineTool({
      id: 'sandbox.execute',
      name: 'Execute in Sandbox',
      description:
        'Runs ONE structured command (executable + arguments, no shell) inside an isolated sandbox. High risk: the framework always requires human confirmation.',
      version: '1.0.0',
      category: 'system',
      inputSchema: defineObjectSchema({
        properties: {
          sandboxId: {
            type: 'string',
            description: 'Target sandbox id.',
            minLength: 1,
            maxLength: 64,
          },
          command: {
            type: 'string',
            description: 'Allowlisted executable name.',
            minLength: 1,
            maxLength: 64,
          },
          arguments: {
            type: 'array',
            description: 'Arguments passed without a shell.',
            items: { type: 'string', minLength: 0, maxLength: 4096 },
          },
          workingDirectory: {
            type: 'string',
            description: 'Workspace-relative working directory.',
            maxLength: 512,
          },
        },
        required: ['sandboxId', 'command'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          status: { type: 'string', description: 'Execution status.' },
          exitCode: { type: 'number', description: 'Process exit code (null when terminated).' },
          stdout: { type: 'string', description: 'Bounded, scrubbed stdout.' },
          stderr: { type: 'string', description: 'Bounded, scrubbed stderr.' },
          timedOut: { type: 'boolean', description: 'Whether the timeout killed the execution.' },
          terminated: {
            type: 'boolean',
            description: 'Whether limits or cancellation terminated it.',
          },
          truncated: { type: 'boolean', description: 'Whether output was truncated.' },
        },
        required: ['status', 'exitCode', 'stdout', 'stderr', 'timedOut', 'terminated', 'truncated'],
        additionalProperties: false,
      }),
      requiredPermissions: ['sandbox.execute'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    implementation: {
      toolId: 'sandbox.execute',
      handler: async (input) => {
        const result = await manager.startExecution(input.sandboxId as string, {
          command: input.command as string,
          arguments: (input.arguments as string[] | undefined) ?? [],
          ...(input.workingDirectory !== undefined
            ? { workingDirectory: input.workingDirectory as string }
            : {}),
        });
        return {
          status: result.status,
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          terminated: result.terminated,
          truncated: result.truncated,
        };
      },
    },
  };

  return {
    definitions: [create.definition, execute.definition],
    implementations: [create.implementation, execute.implementation],
  };
}

// ---------------------------------------------------------------------------
// Complete fixture environment
// ---------------------------------------------------------------------------

export interface CodingFixtureEnvironment {
  readonly projectEngine: ProjectEngine;
  readonly sandboxManager: SandboxManager;
  readonly tools: ToolManager;
  /** Ids of the seeded project + workspace. */
  readonly projectId: string;
  readonly workspaceId: string;
  /** The offline GitHub connector transport (fixture repository state). */
  readonly githubTransport: FakeGitHubTransport;
}

export interface CreateCodingFixtureEnvironmentOptions {
  readonly now?: () => Date;
  readonly sandboxManager?: SandboxManager;
  readonly projectEngine?: ProjectEngine;
  /** When true, wires the offline GitHub connector + tools into the environment. */
  readonly withGitHub?: boolean;
}

/** Permission grants the coding fixture environment hands to the ToolManager. */
export const CODING_FIXTURE_PERMISSIONS = [
  'project.read',
  'project.write',
  'project.delete',
  'sandbox.create',
  'sandbox.execute',
  'github.repositories.read',
  'github.branches.read',
  'github.branches.write',
  'github.contents.read',
  'github.contents.write',
] as const;

/**
 * Builds a full offline Coding Agent environment: in-memory Project Engine,
 * mock sandbox runtime, and a REAL Tool System with the project file tools
 * and the fixture sandbox tools registered (permissions granted explicitly).
 */
export async function createCodingFixtureEnvironment(
  options: CreateCodingFixtureEnvironmentOptions = {},
): Promise<CodingFixtureEnvironment> {
  const now = options.now ?? (() => new Date());
  const projectEngine = options.projectEngine ?? createProjectEngine({ now });
  const sandboxManager =
    options.sandboxManager ?? createMockSandboxManager({ now, auditSink: () => undefined }).manager;

  const githubTransport = new FakeGitHubTransport({
    state: {
      repositories: [
        createFakeRepository({
          owner: 'veltravia-demo',
          name: 'fixture-repo',
          description: 'offline fixture repository',
          files: {
            'README.md': '# Fixture repository\n\nOffline content.',
            'src/index.ts': 'export const value = 1;\n',
          },
        }),
      ],
    },
  });
  const githubRuntime =
    options.withGitHub === true
      ? createGitHubConnectorRuntime({
          connectorId: GITHUB_CONNECTOR_ID,
          connectionId: 'github-connection:fixture',
          scope: {
            repositories: [
              {
                owner: 'veltravia-demo',
                repository: 'fixture-repo',
                defaultBranch: 'main',
              },
            ],
          },
          transport: githubTransport,
          credentialProviderRef: 'env:GITHUB_DEMO_TOKEN',
          now,
        })
      : undefined;

  const connectorManager = new ConnectorManager({ now });
  const tools = new ToolManager({
    now,
    connectors: connectorManager,
    ...(githubRuntime !== undefined
      ? {
          connectorExecutor: createGitHubOperationExecutor({
            runtimes: new Map([[githubRuntime.connectorId, githubRuntime]]),
          }),
        }
      : {}),
  });
  const projectTools = createProjectTools(projectEngine);
  for (const definition of projectTools.definitions) {
    tools.register(definition);
  }
  for (const implementation of projectTools.implementations) {
    tools.registerImplementation(implementation);
  }
  const sandboxTools = createFixtureSandboxTools(sandboxManager);
  for (const definition of sandboxTools.definitions) {
    tools.register(definition);
  }
  for (const implementation of sandboxTools.implementations) {
    tools.registerImplementation(implementation);
  }
  const codingToolIds: string[] = [...Object.values(CODING_TOOL_IDS)];
  if (githubRuntime !== undefined) {
    for (const definition of createGitHubToolDefinitions(GITHUB_CONNECTOR_ID)) {
      tools.register(definition);
    }
    // Connector lifecycle goes through the REAL ConnectorManager: register
    // (grants nothing) -> connect (connect() on the offline fake transport).
    connectorManager.register(githubRuntime.connector);
    await connectorManager.connect(githubRuntime.connectorId);
    codingToolIds.push(
      ...createGitHubToolDefinitions(GITHUB_CONNECTOR_ID).map((definition) => definition.id),
    );
    // The connector permission gate is separate from the tool permission
    // gate - the fixture grants both explicitly (it is the operator).
    for (const permission of CODING_FIXTURE_PERMISSIONS) {
      if (permission.startsWith('github.')) {
        connectorManager.grantPermission(GITHUB_CONNECTOR_ID, permission);
      }
    }
  }
  for (const toolId of codingToolIds) {
    const inspection = tools.inspect(toolId);
    for (const permission of inspection.requiredPermissions) {
      tools.grantPermission(toolId, permission);
    }
  }

  const project = await projectEngine.projects.createProject({
    name: 'fixture-project',
    description: 'offline deterministic fixture project',
    projectType: 'other',
    ownerRef: 'fixture-owner',
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
    name: 'workspace',
  });

  return {
    projectEngine,
    sandboxManager,
    tools,
    projectId: project.id,
    workspaceId: workspace.id,
    githubTransport,
  };
}

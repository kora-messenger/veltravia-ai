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
}

export interface CreateCodingFixtureEnvironmentOptions {
  readonly now?: () => Date;
  readonly sandboxManager?: SandboxManager;
  readonly projectEngine?: ProjectEngine;
}

/** Permission grants the coding fixture environment hands to the ToolManager. */
export const CODING_FIXTURE_PERMISSIONS = [
  'project.read',
  'project.write',
  'project.delete',
  'sandbox.create',
  'sandbox.execute',
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

  const tools = new ToolManager({ now });
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
  for (const toolId of Object.values(CODING_TOOL_IDS)) {
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
  };
}

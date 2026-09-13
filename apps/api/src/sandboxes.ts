import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';
import { defineObjectSchema, defineTool, type ToolDefinition, type ToolImplementation } from '@veltravia/tool-core';

/**
 * Builds the API's SandboxManager.
 *
 * Step 8 ships the MOCK runtime: deterministic, offline, no OS-level
 * isolation - development/CI configuration only. A production runtime
 * (container / microVM / dedicated worker) later implements the same
 * SandboxRuntime interface; nothing else changes.
 */
export function createSandboxManager(options: {
  now?: () => Date;
  auditSink?: (event: unknown) => void;
} = {}): SandboxManager {
  return createMockSandboxManager(options).manager;
}

/**
 * Validates that a workspace reference actually exists in the Project
 * Engine. The sandbox may REFERENCE a workspace, but never bypass Project
 * Engine rules: unknown workspaces are a 404 before any sandbox exists.
 */
export async function assertWorkspaceExists(
  projectEngine: ProjectEngine,
  workspaceRef: string,
): Promise<void> {
  await projectEngine.workspaces.getWorkspace(workspaceRef);
}

/**
 * Sandbox Tools - declared through the Step 5 Tool System, never a bypass.
 *
 * Every tool declares its schema, permissions, risk level, and bounded
 * inputs; execution flows through the ToolManager pipeline (validation,
 * explicit permission grants, risk-based confirmation). `sandbox.execute`
 * is HIGH risk, so the framework forces human confirmation no matter what
 * its declaration says. Registration grants NOTHING: every permission
 * starts empty.
 */
export function createSandboxTools(manager: SandboxManager): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const create: { definition: ToolDefinition; implementation: ToolImplementation } = {
    definition: defineTool({
      id: 'sandbox.create',
      name: 'Create Sandbox',
      description:
        'Creates an isolated sandbox pinned to one project workspace. The profile (command allowlist, network policy, resource limits, TTL) is fixed at creation and immutable.',
      version: '1.0.0',
      category: 'system',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceRef: { type: 'string', description: 'Project Engine workspace id.', minLength: 1, maxLength: 128 },
        },
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
        const sandbox = await manager.createSandbox({
          workspaceRef: input.workspaceRef as string,
        });
        return {
          sandboxId: sandbox.id,
          status: sandbox.status,
          expiresAt: sandbox.expiresAt,
        };
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
          sandboxId: { type: 'string', description: 'Target sandbox id.', minLength: 1, maxLength: 64 },
          command: { type: 'string', description: 'Allowlisted executable name.', minLength: 1, maxLength: 64 },
          arguments: {
            type: 'array',
            description: 'Arguments passed without a shell.',
            items: { type: 'string', minLength: 0, maxLength: 4096 },
          },
          workingDirectory: { type: 'string', description: 'Workspace-relative working directory.', maxLength: 512 },
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
          terminated: { type: 'boolean', description: 'Whether limits or cancellation terminated it.' },
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

  const stop: { definition: ToolDefinition; implementation: ToolImplementation } = {
    definition: defineTool({
      id: 'sandbox.stop',
      name: 'Stop Sandbox',
      description: 'Stops a sandbox and cancels its active execution. Terminal for execution; only destroy follows.',
      version: '1.0.0',
      category: 'system',
      inputSchema: defineObjectSchema({
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox id.', minLength: 1, maxLength: 64 },
        },
        required: ['sandboxId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          status: { type: 'string', description: 'Sandbox status after stopping.' },
        },
        required: ['status'],
        additionalProperties: false,
      }),
      requiredPermissions: ['sandbox.stop'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    implementation: {
      toolId: 'sandbox.stop',
      handler: async (input) => {
        const sandbox = await manager.stopSandbox(input.sandboxId as string);
        return { status: sandbox.status };
      },
    },
  };

  const destroy: { definition: ToolDefinition; implementation: ToolImplementation } = {
    definition: defineTool({
      id: 'sandbox.destroy',
      name: 'Destroy Sandbox',
      description: 'Destroys a sandbox and releases its resources. Terminal and irreversible.',
      version: '1.0.0',
      category: 'system',
      inputSchema: defineObjectSchema({
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox id.', minLength: 1, maxLength: 64 },
        },
        required: ['sandboxId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          status: { type: 'string', description: 'Sandbox status after destruction.' },
        },
        required: ['status'],
        additionalProperties: false,
      }),
      requiredPermissions: ['sandbox.destroy'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    implementation: {
      toolId: 'sandbox.destroy',
      handler: async (input) => {
        const sandbox = await manager.destroySandbox(input.sandboxId as string);
        return { status: sandbox.status };
      },
    },
  };

  return {
    definitions: [create.definition, execute.definition, stop.definition, destroy.definition],
    implementations: [
      create.implementation,
      execute.implementation,
      stop.implementation,
      destroy.implementation,
    ],
  };
}

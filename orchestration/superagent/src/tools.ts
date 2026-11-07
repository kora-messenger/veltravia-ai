/**
 * The worker tool catalog and its authorization gate.
 *
 * The catalog is a closed list, and the gate is server-side: a tool call is
 * refused unless the assignment named that tool, the assignment's permissions
 * cover it, and every path argument is inside the assignment's scope. A model
 * asking for something else is a recorded refusal, not an attempt.
 */

import { WorkerError } from '@veltravia/worker-core';

import { assertAuthorisedPath, type PathAuthority } from './scopes.js';
import type {
  WorkerToolDescriptor,
  WorkerToolHandler,
  WorkerToolInvocation,
  WorkerToolOutcome,
  WorkerToolPermission,
} from './types.js';

export const WORKER_TOOLS: readonly WorkerToolDescriptor[] = [
  {
    id: 'project.list',
    description: 'List files under a project directory.',
    permission: 'read',
    pathArguments: ['path'],
    mutating: false,
  },
  {
    id: 'project.read',
    description: 'Read one project file.',
    permission: 'read',
    pathArguments: ['path'],
    mutating: false,
  },
  {
    id: 'project.search',
    description: 'Search project source for a text pattern.',
    permission: 'read',
    pathArguments: [],
    mutating: false,
  },
  {
    id: 'project.structure',
    description: 'Inspect the project structure and its languages.',
    permission: 'read',
    pathArguments: [],
    mutating: false,
  },
  {
    id: 'project.write',
    description: 'Write a file inside the assignment scope.',
    permission: 'write',
    pathArguments: ['path'],
    mutating: true,
  },
  {
    id: 'tests.run',
    description: 'Run the permitted tests for the assignment scope.',
    permission: 'test',
    pathArguments: [],
    mutating: false,
  },
  {
    id: 'schema.inspect',
    description: 'Inspect database tables and columns.',
    permission: 'schema',
    pathArguments: [],
    mutating: false,
  },
  {
    id: 'docs.write',
    description: 'Write documentation inside the assignment scope.',
    permission: 'write',
    pathArguments: ['path'],
    mutating: true,
  },
];

export function findWorkerTool(id: string): WorkerToolDescriptor | null {
  return WORKER_TOOLS.find((tool) => tool.id === id) ?? null;
}

export const WORKER_TOOL_IDS = WORKER_TOOLS.map((tool) => tool.id);

export interface ToolboxOptions {
  readonly ownerRef: string;
  readonly workerId: string;
  readonly workerType: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly assignment: {
    readonly allowedTools: readonly string[];
    readonly scope: readonly string[];
    readonly exclusions: readonly string[];
    readonly permissions: {
      readonly readProject: boolean;
      readonly writeProject: boolean;
      readonly runTools: boolean;
      readonly network: boolean;
    };
    /** Resolved verification scope; absent means the handler decides. */
    readonly verification?: { readonly operations: readonly string[] } | null;
  };
  readonly handlers: Readonly<Record<string, WorkerToolHandler>>;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly record?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ToolRefusal {
  readonly tool: string;
  readonly code: string;
  readonly message: string;
}

export class WorkerToolbox {
  private readonly options: ToolboxOptions;
  readonly refusals: ToolRefusal[] = [];

  constructor(options: ToolboxOptions) {
    this.options = options;
  }

  get authority(): PathAuthority {
    return { scope: this.options.assignment.scope, exclusions: this.options.assignment.exclusions };
  }

  /** Why this tool may not run for this worker, or null when it may. */
  check(invocation: WorkerToolInvocation): ToolRefusal | null {
    const descriptor = findWorkerTool(invocation.tool);
    if (descriptor === null) {
      return {
        tool: invocation.tool,
        code: 'WORKER_TOOL_UNKNOWN',
        message: 'There is no such tool.',
      };
    }
    if (!this.options.assignment.allowedTools.includes(descriptor.id)) {
      return {
        tool: descriptor.id,
        code: 'WORKER_TOOL_NOT_ASSIGNED',
        message: 'That tool was not part of the assignment.',
      };
    }
    if (!this.permissionAllows(descriptor.permission)) {
      return {
        tool: descriptor.id,
        code: 'WORKER_TOOL_FORBIDDEN',
        message: `That assignment does not grant ${descriptor.permission} permission.`,
      };
    }
    if (this.options.handlers[descriptor.id] === undefined) {
      return {
        tool: descriptor.id,
        code: 'WORKER_TOOL_UNAVAILABLE',
        message: 'That tool is not available in this environment.',
      };
    }
    for (const argument of descriptor.pathArguments) {
      const value = invocation.arguments[argument];
      if (typeof value !== 'string') {
        return {
          tool: descriptor.id,
          code: 'WORKER_TOOL_ARGUMENTS_INVALID',
          message: `${argument} must be a project path.`,
        };
      }
      try {
        assertAuthorisedPath(this.authority, value, argument);
      } catch (error) {
        return {
          tool: descriptor.id,
          code: 'WORKER_TOOL_OUT_OF_SCOPE',
          message: error instanceof Error ? error.message : 'That path is outside the assignment.',
        };
      }
    }
    return null;
  }

  private permissionAllows(permission: WorkerToolPermission): boolean {
    const permissions = this.options.assignment.permissions;
    switch (permission) {
      case 'read':
        return permissions.readProject;
      case 'write':
        return permissions.writeProject;
      case 'test':
        return permissions.runTools;
      case 'schema':
        return permissions.readProject;
      case 'network':
        return permissions.network;
      default:
        return false;
    }
  }

  /** Runs one authorized tool. Refusals are recorded and returned, never thrown. */
  async invoke(invocation: WorkerToolInvocation): Promise<WorkerToolOutcome> {
    const refusal = this.check(invocation);
    if (refusal !== null) {
      this.refusals.push(refusal);
      this.options.record?.(`Refused ${refusal.tool}: ${refusal.message}`, {
        tool: refusal.tool,
        code: refusal.code,
      });
      return { ok: false, code: refusal.code, message: refusal.message };
    }
    const handler = this.options.handlers[invocation.tool];
    if (handler === undefined) {
      return { ok: false, code: 'WORKER_TOOL_UNAVAILABLE', message: 'That tool is not available.' };
    }
    if (this.options.signal.aborted) {
      throw new WorkerError('WORKER_CANCELLED', 'The worker was cancelled.');
    }
    try {
      const outcome = await handler(invocation, {
        ownerRef: this.options.ownerRef,
        workerId: this.options.workerId,
        workerType: this.options.workerType,
        taskId: this.options.taskId,
        projectId: this.options.projectId,
        verificationOperations: this.options.assignment.verification?.operations ?? [],
        signal: this.options.signal,
        deadline: this.options.deadline,
        record: this.options.record ?? (() => undefined),
      });
      this.options.record?.(
        outcome.ok
          ? `Ran ${invocation.tool}`
          : `Tool ${invocation.tool} failed: ${outcome.message}`,
        { tool: invocation.tool, ok: outcome.ok },
      );
      return outcome;
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      const message = error instanceof Error ? error.message : 'The tool failed.';
      this.options.record?.(`Tool ${invocation.tool} failed`, { tool: invocation.tool });
      return { ok: false, code: 'WORKER_TOOL_FAILED', message };
    }
  }
}

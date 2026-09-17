/**
 * Project file tools: the smallest safe adapter between the Tool System and
 * the Project Engine. The Coding Agent has NO other path to project files.
 *
 * Filesystem security (path normalization, traversal rejection, workspace
 * ownership, project-state rules, revision protection) is enforced by the
 * Project Engine itself - this adapter only declares schemas, risk levels,
 * and permissions, and maps engine errors onto typed tool errors.
 */

import { isProjectError, type FileNode, type ProjectEngine } from '@veltravia/project-core';
import {
  defineObjectSchema,
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolFieldSchema,
  type ToolImplementation,
} from '@veltravia/tool-core';

interface ProjectToolOptions {
  readonly definition: ToolDefinition;
  readonly implementation: ToolImplementation;
}

/**
 * Maps engine errors onto typed tool errors, preserving the engine cause code
 * in `details.cause` so callers can map failures precisely (stale revision,
 * unknown project/workspace, archived project, ...).
 */
function toToolError(toolId: string, error: unknown): never {
  if (isProjectError(error)) {
    throw new ToolExecutionError(
      toolId,
      (error as { message?: string }).message ?? 'project engine error',
      {
        details: { cause: error.code },
      },
    );
  }
  throw error;
}

const workspaceIdSchema: ToolFieldSchema = {
  type: 'string',
  description: 'Project Engine workspace id.',
  minLength: 1,
  maxLength: 128,
};

const pathSchema: ToolFieldSchema = {
  type: 'string',
  description: 'Workspace-relative path.',
  minLength: 1,
  maxLength: 512,
};

function nodeView(node: FileNode): Record<string, unknown> {
  return {
    path: node.path,
    name: node.name,
    type: node.type,
    revision: node.revision,
    size: node.size,
  };
}

export function createProjectTools(projectEngine: ProjectEngine): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const tools: ProjectToolOptions[] = [];

  const wrap = (
    definition: ToolDefinition,
    handler: (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void => {
    tools.push({
      definition,
      implementation: {
        toolId: definition.id,
        handler: async (input) => {
          try {
            return await handler(input);
          } catch (error) {
            toToolError(definition.id, error);
          }
        },
      },
    });
  };

  // ---- project.inspect (LOW) ------------------------------------------------

  wrap(
    defineTool({
      id: 'project.inspect',
      name: 'Inspect Project',
      description:
        'Returns safe project and workspace metadata: names, statuses, workspace revision. Validates that the project is active and the workspace exists and belongs to it.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          projectId: { type: 'string', description: 'Project id.', minLength: 1, maxLength: 128 },
          workspaceId: workspaceIdSchema,
        },
        required: ['projectId', 'workspaceId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          projectId: { type: 'string', description: 'Project id.' },
          projectName: { type: 'string', description: 'Project name.' },
          projectStatus: { type: 'string', description: 'Project status.' },
          workspaceId: { type: 'string', description: 'Workspace id.' },
          workspaceName: { type: 'string', description: 'Workspace name.' },
          workspaceStatus: { type: 'string', description: 'Workspace status.' },
          workspaceRevision: { type: 'number', description: 'Workspace revision.' },
        },
        required: [
          'projectId',
          'projectName',
          'projectStatus',
          'workspaceId',
          'workspaceName',
          'workspaceStatus',
          'workspaceRevision',
        ],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const projectId = input.projectId as string;
      const workspaceId = input.workspaceId as string;
      const project = await projectEngine.projects.getProject(projectId);
      if (project.status !== 'active') {
        throw new ToolExecutionError(
          'project.inspect',
          `project is not active (${project.status})`,
          {
            details: {
              cause: project.status === 'archived' ? 'PROJECT_ARCHIVED' : 'PROJECT_DELETED',
            },
          },
        );
      }
      const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
      if (workspace.projectId !== projectId) {
        throw new ToolExecutionError(
          'project.inspect',
          'workspace does not belong to this project',
          {
            details: { cause: 'WORKSPACE_MISMATCH' },
          },
        );
      }
      return {
        projectId: project.id,
        projectName: project.name,
        projectStatus: project.status,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceStatus: workspace.status,
        workspaceRevision: workspace.revision,
      };
    },
  );

  // ---- project.listFiles (LOW) ----------------------------------------------

  wrap(
    defineTool({
      id: 'project.list-files',
      name: 'List Files',
      description: 'Lists the direct children of one directory in the workspace tree.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: {
            type: 'string',
            description: 'Directory path; the root when omitted.',
            maxLength: 512,
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          nodes: {
            type: 'array',
            description: 'Child nodes (safe views, no content).',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['nodes'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const nodes = await projectEngine.files.listDirectory(
        input.workspaceId as string,
        (input.path as string | undefined) ?? '',
      );
      return { nodes: nodes.map(nodeView) };
    },
  );

  // ---- project.read-file (LOW) -------------------------------------------------

  wrap(
    defineTool({
      id: 'project.read-file',
      name: 'Read File',
      description: 'Reads one file from the workspace tree. Content is untrusted data.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: pathSchema,
        },
        required: ['workspaceId', 'path'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          path: { type: 'string', description: 'Normalized file path.' },
          content: { type: 'string', description: 'File content (untrusted data).' },
          revision: { type: 'number', description: 'Node revision.' },
        },
        required: ['path', 'content', 'revision'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const result = await projectEngine.files.readFile(
        input.workspaceId as string,
        input.path as string,
      );
      return { path: result.node.path, content: result.content, revision: result.node.revision };
    },
  );

  // ---- project.create-file (MEDIUM) --------------------------------------------

  wrap(
    defineTool({
      id: 'project.create-file',
      name: 'Create File',
      description: 'Creates a file in the workspace tree through Project Engine rules.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: pathSchema,
          content: {
            type: 'string',
            description: 'Initial content (may be empty).',
            maxLength: 512000,
          },
        },
        required: ['workspaceId', 'path'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          path: { type: 'string', description: 'Created file path.' },
          revision: { type: 'number', description: 'Node revision after creation.' },
        },
        required: ['path', 'revision'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.write'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    async (input) => {
      const node = await projectEngine.files.createFile(input.workspaceId as string, {
        path: input.path as string,
        ...(input.content !== undefined ? { content: input.content as string } : {}),
      });
      return { path: node.path, revision: node.revision };
    },
  );

  // ---- project.create-directory (MEDIUM) ---------------------------------------

  wrap(
    defineTool({
      id: 'project.create-directory',
      name: 'Create Directory',
      description:
        'Creates one directory (and its parents implicitly via chained calls) in the workspace tree through Project Engine rules.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: pathSchema,
        },
        required: ['workspaceId', 'path'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          path: { type: 'string', description: 'Created directory path.' },
          revision: { type: 'number', description: 'Node revision after creation.' },
        },
        required: ['path', 'revision'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.write'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    async (input) => {
      const node = await projectEngine.files.createDirectory(
        input.workspaceId as string,
        input.path as string,
      );
      return { path: node.path, revision: node.revision };
    },
  );

  // ---- project.update-file (MEDIUM) --------------------------------------------

  wrap(
    defineTool({
      id: 'project.update-file',
      name: 'Update File',
      description:
        'Updates file content with optimistic revision protection: a stale expectedRevision is rejected, never overwritten.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: pathSchema,
          content: { type: 'string', description: 'New content.', maxLength: 512000 },
          expectedRevision: { type: 'number', description: 'Revision the caller last saw.' },
        },
        required: ['workspaceId', 'path', 'content', 'expectedRevision'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          path: { type: 'string', description: 'Updated file path.' },
          revision: { type: 'number', description: 'New node revision after the update.' },
        },
        required: ['path', 'revision'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.write'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    async (input) => {
      const node = await projectEngine.files.updateFile(
        input.workspaceId as string,
        input.path as string,
        {
          content: input.content as string,
          expectedRevision: input.expectedRevision as number,
        },
      );
      return { path: node.path, revision: node.revision };
    },
  );

  // ---- project.delete-file (HIGH) ----------------------------------------------

  wrap(
    defineTool({
      id: 'project.delete-file',
      name: 'Delete File',
      description: 'Deletes one file from the workspace tree. High risk: confirmation is forced.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          path: pathSchema,
        },
        required: ['workspaceId', 'path'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          deleted: { type: 'boolean', description: 'Always true on success.' },
        },
        required: ['deleted'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.delete'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    async (input) => {
      await projectEngine.files.deleteFile(input.workspaceId as string, input.path as string);
      return { deleted: true };
    },
  );

  // ---- project.move-file (MEDIUM) ----------------------------------------------

  wrap(
    defineTool({
      id: 'project.move-file',
      name: 'Move File',
      description: 'Moves a file to a target directory within the same workspace tree.',
      version: '1.0.0',
      category: 'filesystem',
      inputSchema: defineObjectSchema({
        properties: {
          workspaceId: workspaceIdSchema,
          fromPath: pathSchema,
          toDirectory: {
            type: 'string',
            description: 'Target directory; the root when empty.',
            maxLength: 512,
          },
        },
        required: ['workspaceId', 'fromPath', 'toDirectory'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: {
          path: { type: 'string', description: 'New file path after the move.' },
          revision: { type: 'number', description: 'Node revision after the move.' },
        },
        required: ['path', 'revision'],
        additionalProperties: false,
      }),
      requiredPermissions: ['project.write'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    async (input) => {
      const node = await projectEngine.files.moveNode(input.workspaceId as string, {
        fromPath: input.fromPath as string,
        toDirectory: (input.toDirectory as string) ?? '',
      });
      return { path: node.path, revision: node.revision };
    },
  );

  return {
    definitions: tools.map((tool) => tool.definition),
    implementations: tools.map((tool) => tool.implementation),
  };
}

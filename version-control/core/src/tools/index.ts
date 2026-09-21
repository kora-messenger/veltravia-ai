/**
 * Version Control tools (Step 18).
 *
 * The Tool System is the ONLY execution path for version-control
 * mutations: `version.rollback` (CRITICAL risk, forced human confirmation
 * bound to the exact rollback input), `version.capture-revision` and
 * `version.create-checkpoint` (write-permission-gated). Registration grants
 * NOTHING - the API wiring grants exactly the permissions below, and no
 * agent receives them unless an operator grants them explicitly.
 *
 * Rollback restores ONLY through the manager (validated plan -> Project
 * Engine gateway -> verified tree). There is no other execution path.
 */

import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';

import { VersionError } from '../errors/index.js';
import type { VersionControlManager } from '../manager/index.js';

const projectIdSchema = {
  type: 'string',
  description: 'Project id.',
  minLength: 1,
  maxLength: 128,
} as const;
const workspaceIdSchema = {
  type: 'string',
  description: 'Workspace id.',
  minLength: 1,
  maxLength: 128,
} as const;

function toToolError(toolId: string, error: unknown): never {
  if (error instanceof VersionError) {
    throw new ToolExecutionError(toolId, error.message, {
      details: { cause: error.code, ...error.details },
    });
  }
  throw error;
}

function stringInput(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolExecutionError('version', `Input "${key}" is required.`, {
      details: { cause: 'VERSION_INVALID_REQUEST' },
    });
  }
  return value;
}

function optionalStringInput(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createVersionTools(manager: VersionControlManager): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];

  const register = (
    definition: ToolDefinition,
    handler: (
      input: Readonly<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input) => {
        try {
          return await handler(input);
        } catch (error) {
          toToolError(definition.id, error);
        }
      },
    });
  };

  register(
    defineTool({
      id: 'version.capture-revision',
      name: 'Capture Revision',
      description:
        'Captures the current workspace tree as a new immutable revision (checkpoint-able point in time).',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: projectIdSchema,
          workspaceId: workspaceIdSchema,
          message: {
            type: 'string',
            description: 'Optional description of this revision.',
            maxLength: 500,
          },
          source: {
            type: 'string',
            description:
              'One of: manual, generation_before, generation_after, testing_before_repair, testing_after, coding_before, coding_after.',
          },
        },
        required: ['projectId', 'workspaceId', 'source'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          revisionId: { type: 'string', description: 'The new revision id.' },
          revisionNumber: { type: 'number', description: 'Workspace revision number.' },
        },
        required: ['revisionId', 'revisionNumber'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['version.write'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const revision = await manager.captureRevision({
        projectId: stringInput(input, 'projectId'),
        workspaceId: stringInput(input, 'workspaceId'),
        source: stringInput(input, 'source') as never,
        message: optionalStringInput(input, 'message') ?? null,
      });
      return { revisionId: revision.id, revisionNumber: revision.revisionNumber };
    },
  );

  register(
    defineTool({
      id: 'version.create-checkpoint',
      name: 'Create Checkpoint',
      description:
        'Creates a named checkpoint referencing an immutable revision (or a fresh capture).',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: projectIdSchema,
          workspaceId: workspaceIdSchema,
          name: { type: 'string', description: 'Checkpoint name.', minLength: 1, maxLength: 200 },
          description: { type: 'string', description: 'Optional details.', maxLength: 1000 },
          revisionId: { type: 'string', description: 'Optional existing revision to pin.' },
        },
        required: ['projectId', 'workspaceId', 'name'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          checkpointId: { type: 'string', description: 'The new checkpoint id.' },
          revisionId: { type: 'string', description: 'The pinned revision id.' },
        },
        required: ['checkpointId', 'revisionId'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['version.write'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (input) => {
      const checkpoint = await manager.createCheckpoint({
        projectId: stringInput(input, 'projectId'),
        workspaceId: stringInput(input, 'workspaceId'),
        name: stringInput(input, 'name'),
        description: optionalStringInput(input, 'description') ?? null,
        revisionId: optionalStringInput(input, 'revisionId'),
      });
      return { checkpointId: checkpoint.id, revisionId: checkpoint.revisionId };
    },
  );

  register(
    defineTool({
      id: 'version.rollback',
      name: 'Rollback Workspace',
      description:
        'Restores the workspace tree to a historical revision by creating a NEW revision. Critical risk: a human confirmation bound to the exact input is always required. Historical revisions are never deleted.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: projectIdSchema,
          workspaceId: workspaceIdSchema,
          targetRevisionId: {
            type: 'string',
            description: 'The revision whose state will be restored.',
            minLength: 1,
            maxLength: 128,
          },
          expectedCurrentRevision: {
            type: 'number',
            description: 'The workspace revision the caller believes is current.',
            minimum: 0,
          },
          reason: { type: 'string', description: 'Why this rollback is needed.', maxLength: 500 },
        },
        required: ['projectId', 'workspaceId', 'targetRevisionId', 'expectedCurrentRevision'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          newRevisionId: {
            type: 'string',
            description: 'The NEW revision created by the rollback.',
          },
          newRevisionNumber: { type: 'number', description: 'Its workspace revision number.' },
          restoredFromRevisionId: { type: 'string', description: 'The restored revision id.' },
          restoredFromRevisionNumber: {
            type: 'number',
            description: 'The restored revision number.',
          },
          filesChanged: { type: 'number', description: 'Restore steps applied.' },
        },
        required: [
          'newRevisionId',
          'newRevisionNumber',
          'restoredFromRevisionId',
          'restoredFromRevisionNumber',
          'filesChanged',
        ],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['version.execute'],
      riskLevel: 'critical',
      requiresConfirmation: true,
    }),
    async (input) => {
      const result = await manager.executeRollback({
        projectId: stringInput(input, 'projectId'),
        workspaceId: stringInput(input, 'workspaceId'),
        targetRevisionId: stringInput(input, 'targetRevisionId'),
        expectedCurrentRevision: Number(input.expectedCurrentRevision),
        reason: optionalStringInput(input, 'reason') ?? null,
      });
      return { ...result };
    },
  );

  return { definitions, implementations };
}

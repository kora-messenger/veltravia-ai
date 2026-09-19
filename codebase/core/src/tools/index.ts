/**
 * Codebase analysis tools (Phase 22).
 *
 * Read-only ANALYSIS operations the Agent Layer can request through the
 * existing Tool System. Every tool is low-risk, permission-gated, and
 * mutates NOTHING: they answer from index evidence only. High-risk
 * operations do not exist in this set by design - analysis can never
 * become mutation.
 */

import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';

import type { CodebaseIntelligenceManager } from '../manager/index.js';
import { CodebaseError } from '../errors/index.js';

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

interface CodebaseToolOptions {
  readonly definition: ToolDefinition;
  readonly implementation: ToolImplementation;
}

function toToolError(toolId: string, error: unknown): never {
  if (error instanceof CodebaseError) {
    throw new ToolExecutionError(toolId, error.message, {
      details: { cause: error.code },
    });
  }
  throw error;
}

export function createCodebaseTools(manager: CodebaseIntelligenceManager): {
  definitions: ToolDefinition[];
  implementations: ToolImplementation[];
} {
  const tools: CodebaseToolOptions[] = [];

  const wrap = (
    id: string,
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void => {
    const definition = defineTool({
      id,
      name,
      description,
      version: '0.1.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: inputSchema.properties as never,
        required: inputSchema.required as never,
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          results: { type: 'array', description: 'Bounded analysis results (safe views).' },
        },
        required: ['results'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['codebase.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    });
    tools.push({
      definition,
      implementation: {
        toolId: id,
        handler: async (input: Record<string, unknown>) => {
          try {
            return await handler(input);
          } catch (error) {
            toToolError(id, error);
          }
        },
      },
    });
  };

  wrap(
    'codebase.search',
    'Search Codebase',
    'Searches the project codebase index (exact text, symbol, file, relationship, or structural search). Read-only analysis; returns evidence-backed results.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        query: { type: 'string', description: 'Search text.', minLength: 1, maxLength: 200 },
        searchType: {
          type: 'string',
          description: 'One of: exact, symbol, file, relationship, structural.',
        },
      },
      required: ['projectId', 'workspaceId', 'query', 'searchType'],
    },
    async (input) => {
      const results = await manager.search(input.projectId as string, input.workspaceId as string, {
        query: input.query as string,
        searchType: input.searchType as 'exact',
      });
      return { results: results.slice(0, 20) };
    },
  );

  wrap(
    'codebase.find_symbol',
    'Find Symbol',
    'Finds symbols by name in the project codebase index and returns their file, range, and evidence. Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        name: { type: 'string', description: 'Symbol name to find.', minLength: 1, maxLength: 200 },
      },
      required: ['projectId', 'workspaceId', 'name'],
    },
    async (input) => {
      const results = await manager.search(input.projectId as string, input.workspaceId as string, {
        query: input.name as string,
        searchType: 'symbol',
      });
      return { results: results.slice(0, 20) };
    },
  );

  wrap(
    'codebase.find_references',
    'Find References',
    'Finds files that import or reference a given symbol in the codebase index. Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        symbolId: {
          type: 'string',
          description: 'Symbol id from the index.',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['projectId', 'workspaceId', 'symbolId'],
    },
    async (input) => {
      const results = await manager.findReferences(
        input.projectId as string,
        input.workspaceId as string,
        input.symbolId as string,
      );
      return { results: results.slice(0, 20) };
    },
  );

  wrap(
    'codebase.find_callers',
    'Find Callers',
    'Finds symbols that call the given symbol, from recorded call relationships. Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        symbolId: {
          type: 'string',
          description: 'Symbol id from the index.',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['projectId', 'workspaceId', 'symbolId'],
    },
    async (input) => {
      const results = await manager.findCallers(
        input.projectId as string,
        input.workspaceId as string,
        input.symbolId as string,
      );
      return { results: results.slice(0, 20) };
    },
  );

  wrap(
    'codebase.find_callees',
    'Find Callees',
    'Finds the symbols the given symbol calls, from recorded call relationships. Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        symbolId: {
          type: 'string',
          description: 'Symbol id from the index.',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['projectId', 'workspaceId', 'symbolId'],
    },
    async (input) => {
      const results = await manager.findCallees(
        input.projectId as string,
        input.workspaceId as string,
        input.symbolId as string,
      );
      return { results: results.slice(0, 20) };
    },
  );

  wrap(
    'codebase.trace_feature',
    'Trace Feature',
    'Builds a bounded, evidence-backed feature map for a feature description (files, symbols, relationships). Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        feature: {
          type: 'string',
          description: 'Feature to trace, e.g. "authentication".',
          minLength: 2,
          maxLength: 200,
        },
      },
      required: ['projectId', 'workspaceId', 'feature'],
    },
    async (input) => {
      const trace = await manager.traceFeature(
        input.projectId as string,
        input.workspaceId as string,
        {
          feature: input.feature as string,
        },
      );
      return {
        results: [
          { nodes: trace.nodes.slice(0, 40), edges: trace.edges.slice(0, 80), notes: trace.notes },
        ],
      };
    },
  );

  wrap(
    'codebase.get_summary',
    'Get Codebase Summary',
    'Returns the evidence-derived codebase summary (languages, frameworks, entry points, routes, counts). Read-only analysis.',
    {
      properties: { projectId: projectIdSchema, workspaceId: workspaceIdSchema },
      required: ['projectId', 'workspaceId'],
    },
    async (input) => {
      const summary = await manager.getSummary(
        input.projectId as string,
        input.workspaceId as string,
      );
      return { results: [summary] };
    },
  );

  wrap(
    'codebase.get_file_symbols',
    'Get File Symbols',
    'Returns the indexed symbols of one file (names, kinds, ranges). Read-only analysis.',
    {
      properties: {
        projectId: projectIdSchema,
        workspaceId: workspaceIdSchema,
        path: {
          type: 'string',
          description: 'Workspace-relative file path.',
          minLength: 1,
          maxLength: 512,
        },
      },
      required: ['projectId', 'workspaceId', 'path'],
    },
    async (input) => {
      const symbols = await manager.getFileSymbols(
        input.projectId as string,
        input.workspaceId as string,
        input.path as string,
      );
      return { results: symbols.slice(0, 100) };
    },
  );

  return {
    definitions: tools.map((tool) => tool.definition),
    implementations: tools.map((tool) => tool.implementation),
  };
}

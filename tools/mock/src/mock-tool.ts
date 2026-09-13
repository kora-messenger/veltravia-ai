import {
  defineObjectSchema,
  defineTool,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';

/**
 * A deterministic, offline, credential-free mock tool.
 *
 * It exists ONLY to prove the Tool System works: schema validation, explicit
 * permission grants, risk-based confirmation, typed execution, and output
 * normalization. It simulates NO external service (not GitHub, not a
 * database, not production infrastructure) - its handler is a pure function.
 */

/** Injectable clock for deterministic timestamps. */
export interface MockToolOptions {
  readonly now?: () => Date;
}

/**
 * "mock.summarize" - a low-risk, executable mock tool.
 *
 * Input: { items: string[] (required), joiner?: string }
 * Output: { text: string, count: number }
 * Demonstrates: input validation (required array, optional string),
 * normalized schema-validated output, deterministic behavior.
 */
export function createMockSummarizeTool(): {
  definition: ToolDefinition;
  implementation: ToolImplementation;
} {
  const definition = defineTool({
    id: 'mock.summarize',
    name: 'Summarize Items',
    description:
      'Deterministic offline mock tool: joins text items into a summary and counts them. Talks to no external service.',
    version: '1.0.0',
    category: 'data',
    inputSchema: defineObjectSchema({
      description: 'Items to summarize.',
      properties: {
        items: {
          type: 'array',
          description: 'Text items to join.',
          items: { type: 'string', minLength: 1 },
        },
        joiner: { type: 'string', description: 'Separator (default: single space).', maxLength: 8 },
      },
      required: ['items'],
      additionalProperties: false,
    }),
    outputSchema: defineObjectSchema({
      description: 'Normalized summary.',
      properties: {
        text: { type: 'string', description: 'Joined items.' },
        count: { type: 'number', description: 'Number of items.' },
      },
      required: ['text', 'count'],
      additionalProperties: false,
    }),
    requiredPermissions: ['mock.read'],
    riskLevel: 'low',
    requiresConfirmation: false,
  });
  const implementation: ToolImplementation = {
    toolId: definition.id,
    handler: (input) => {
      const items = input.items as readonly string[];
      const joiner = typeof input.joiner === 'string' ? input.joiner : ' ';
      return { text: items.join(joiner), count: items.length };
    },
  };
  return { definition, implementation };
}

/**
 * "mock.purge" - a CRITICAL-risk mock tool whose declaration says
 * requiresConfirmation: false, proving the framework still forces
 * confirmation for high/critical risk (the flag can only raise the bar).
 * Its handler is deterministic and safe, but the gate must stop it first.
 */
export function createMockPurgeTool(): {
  definition: ToolDefinition;
  implementation: ToolImplementation;
} {
  const definition = defineTool({
    id: 'mock.purge',
    name: 'Purge Mock Data',
    description:
      'Deterministic offline mock tool marked critical risk. Its declaration says confirmation is not required - the framework must still demand it.',
    version: '1.0.0',
    category: 'system',
    inputSchema: defineObjectSchema({
      properties: {
        confirmLabel: { type: 'string', description: 'Cosmetic label only.', maxLength: 32 },
      },
      required: ['confirmLabel'],
      additionalProperties: false,
    }),
    outputSchema: defineObjectSchema({
      properties: {
        purged: { type: 'boolean', description: 'Always true - no real data exists.' },
      },
      required: ['purged'],
      additionalProperties: false,
    }),
    requiredPermissions: ['mock.admin'],
    riskLevel: 'critical',
    requiresConfirmation: false,
  });
  const implementation: ToolImplementation = {
    toolId: definition.id,
    handler: () => ({ purged: true }),
  };
  return { definition, implementation };
}

/**
 * "mock.connector.read" - a tool that REFERENCES the Step 4 mock connector's
 * operation. It demonstrates the Tool -> Connector -> Operation relationship
 * and the non-bypass rule: its execution is authorization-only in Step 5
 * (external execution is not enabled), and it must never have a local
 * handler. No vendor connector is touched.
 */
export function createConnectorBackedMockTool(): ToolDefinition {
  return defineTool({
    id: 'mock.connector.read',
    name: 'Read Via Mock Connector',
    description:
      'Mock tool routing to the offline mock connector operation "mock.read". Proves the Tool -> ConnectorManager -> Connector relationship; connector operation execution is not enabled in Step 5.',
    version: '1.0.0',
    category: 'data',
    inputSchema: defineObjectSchema({
      properties: {
        resourceId: {
          type: 'string',
          description: 'Mock resource id.',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['resourceId'],
      additionalProperties: false,
    }),
    outputSchema: defineObjectSchema({
      properties: {
        message: { type: 'string', description: 'Normalized result placeholder.' },
      },
      required: ['message'],
      additionalProperties: false,
    }),
    requiredPermissions: ['mock.read'],
    connector: { connectorId: 'mock', operationId: 'mock.read' },
    riskLevel: 'low',
    requiresConfirmation: false,
  });
}

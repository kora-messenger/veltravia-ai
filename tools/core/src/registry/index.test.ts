import { describe, expect, it } from 'vitest';
import { defineTool, type ToolDefinition } from '../types/index.js';
import { defineObjectSchema } from '../validation/schema.js';
import {
  DuplicateToolError,
  InvalidToolDefinitionError,
  ToolNotFoundError,
} from '../errors/index.js';
import { ToolRegistry } from './index.js';

function stubTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return defineTool({
    id: 'stub.read',
    name: 'Stub Read',
    description: 'A structurally valid stub tool.',
    version: '1.0.0',
    category: 'data',
    inputSchema: defineObjectSchema({
      properties: { resourceId: { type: 'string', minLength: 1 } },
      required: ['resourceId'],
      additionalProperties: false,
    }),
    outputSchema: defineObjectSchema({
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    }),
    requiredPermissions: ['stub.read'],
    riskLevel: 'low',
    requiresConfirmation: false,
    ...overrides,
  });
}

describe('defineTool', () => {
  it('creates a validated definition', () => {
    const tool = stubTool();
    expect(tool.id).toBe('stub.read');
    expect(tool.riskLevel).toBe('low');
    expect(tool.connector).toBeUndefined();
  });

  it('collects every problem in one error', () => {
    expect(() => stubTool({ id: 'BAD ID', version: 'one', category: 'dreams' as never })).toThrow(
      /must be lowercase.*must be semver.*category is unknown/s,
    );
  });

  it('requires at least one declared permission and a known risk level', () => {
    expect(() => stubTool({ requiredPermissions: [] })).toThrow(/at least one permission/);
    expect(() => stubTool({ riskLevel: 'extreme' as never })).toThrow(/riskLevel/);
    expect(() => stubTool({ requiresConfirmation: undefined as never })).toThrow(
      /requiresConfirmation/,
    );
  });

  it('validates connector references when present', () => {
    expect(() => stubTool({ connector: { connectorId: '', operationId: 'x' } })).toThrow(
      /connectorId and operationId/,
    );
    expect(() =>
      stubTool({ connector: { connectorId: 'mock', operationId: 'mock.read' } }),
    ).not.toThrow();
  });
});

describe('ToolRegistry', () => {
  it('registers and retrieves a tool by id', () => {
    const registry = new ToolRegistry();
    const tool = stubTool();
    registry.register(tool);
    expect(registry.has('stub.read')).toBe(true);
    expect(registry.get('stub.read')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('rejects duplicate ids', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool());
    expect(() => registry.register(stubTool())).toThrowError(DuplicateToolError);
  });

  it('lists tools in registration order and unregisters cleanly', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool());
    registry.register(
      stubTool({ id: 'stub.write', name: 'Stub Write', requiredPermissions: ['stub.write'] }),
    );
    expect(registry.ids()).toEqual(['stub.read', 'stub.write']);
    registry.unregister('stub.read');
    expect(registry.has('stub.read')).toBe(false);
    // The id is free again.
    expect(() => registry.register(stubTool())).not.toThrow();
  });

  it('throws when getting or unregistering unknown tools', () => {
    const registry = new ToolRegistry();
    expect(() => registry.get('missing.tool')).toThrowError(ToolNotFoundError);
    expect(() => registry.unregister('missing.tool')).toThrowError(ToolNotFoundError);
  });

  it('rejects structurally invalid definitions with all reasons, atomically', () => {
    const registry = new ToolRegistry();
    const bad = {
      ...stubTool(),
      version: 'not-semver',
      requiredPermissions: [],
      riskLevel: 'spooky' as never,
    };
    let error: unknown;
    try {
      registry.register(bad as never);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InvalidToolDefinitionError);
    const message = (error as InvalidToolDefinitionError).message;
    expect(message).toContain('semver');
    expect(message).toContain('requiredPermissions');
    expect(message).toContain('riskLevel');
    expect(registry.size).toBe(0);
  });

  it('rejects schemas that are not object schemas', () => {
    const registry = new ToolRegistry();
    const bad = { ...stubTool(), inputSchema: { type: 'string' as never } };
    expect(() => registry.register(bad as never)).toThrowError(/inputSchema/);
  });

  it('rejects invalid connector references in definitions', () => {
    const registry = new ToolRegistry();
    const bad = { ...stubTool(), connector: { connectorId: 'mock' } };
    expect(() => registry.register(bad as never)).toThrowError(/connectorId and operationId/);
  });
});

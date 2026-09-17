import { describe, expect, it } from 'vitest';
import { redactSecrets } from '@veltravia/connector-core';

import { defineIntegration } from './integration.js';
import { isIntegrationCategory } from './category.js';
import { validIntegrationDefinition } from '../testing/index.js';

const validDefinition = validIntegrationDefinition;

describe('defineIntegration', () => {
  it('accepts a valid definition and normalizes it defensively', () => {
    const definition = defineIntegration(validDefinition());
    expect(definition.id).toBe('demo-store');
    expect(definition.scopes).toHaveLength(3);
    expect(definition.tools).toHaveLength(3);
  });

  it('carries no credential VALUE fields (secret-shaped text is rejected)', () => {
    const definition = defineIntegration(validDefinition());
    const serialized = JSON.stringify(definition);
    expect(redactSecrets(serialized)).toBe(serialized);
    expect(Object.keys(definition)).not.toContain('credential');
  });

  it('rejects an invalid id', () => {
    expect(() => defineIntegration({ ...validDefinition(), id: 'Not A Valid Id' })).toThrow(/id/);
  });

  it('rejects a bad semver', () => {
    expect(() => defineIntegration({ ...validDefinition(), version: 'one.zero' })).toThrow(
      /semver/,
    );
  });

  it('rejects an unknown category', () => {
    expect(() => defineIntegration({ ...validDefinition(), category: 'games' as never })).toThrow(
      /category/,
    );
  });

  it('rejects an unknown authentication type', () => {
    expect(() =>
      defineIntegration({ ...validDefinition(), authenticationType: 'magic' as never }),
    ).toThrow(/authenticationType/);
  });

  it('rejects unknown capabilities', () => {
    expect(() =>
      defineIntegration({
        ...validDefinition(),
        capabilities: ['read', 'teleport'] as never,
      }),
    ).toThrow(/capability/);
  });

  it('rejects a tool that requires an undeclared scope', () => {
    const definition = validDefinition();
    const tools = definition.tools.map((tool) =>
      tool.id === 'storage.object.get' ? { ...tool, requiredScopes: ['storage.admin.read'] } : tool,
    );
    expect(() => defineIntegration({ ...definition, tools })).toThrow(/does not declare/);
  });

  it('rejects duplicate tool ids', () => {
    const definition = validDefinition();
    const tools = [...definition.tools, { ...(definition.tools[0] as object) }];
    expect(() => defineIntegration({ ...definition, tools: tools as never })).toThrow(/twice/);
  });

  it('rejects secret-shaped metadata values', () => {
    const definition = validDefinition();
    expect(() =>
      defineIntegration({
        ...definition,
        description: 'Integration powered by token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      }),
    ).toThrow(/secret-shaped/);
  });

  it('rejects non-https documentation urls', () => {
    expect(() =>
      defineIntegration({
        ...validDefinition(),
        documentation: [{ label: 'Docs', url: 'http://example.com' }],
      }),
    ).toThrow(/https/);
  });
});

describe('isIntegrationCategory', () => {
  it('accepts known categories and rejects unknown ones', () => {
    expect(isIntegrationCategory('storage')).toBe(true);
    expect(isIntegrationCategory('development')).toBe(true);
    expect(isIntegrationCategory('databases')).toBe(true);
    expect(isIntegrationCategory('games')).toBe(false);
    expect(isIntegrationCategory(42)).toBe(false);
  });
});

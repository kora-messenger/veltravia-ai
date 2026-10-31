import { describe, expect, it } from 'vitest';
import { ToolManager } from '@veltravia/tool-core';
import { createMockConnectedAppProviders } from '@veltravia/connected-apps-mock';
import {
  ConnectedAppManager,
  ConnectedResourceIntelligence,
  InMemoryCredentialVault,
  ProviderRegistry,
  createConnectedAppTools,
  type AnalyzerInput,
  type ResourceAnalyzer,
} from '../index.js';

const owner = { ownerRef: 'owner-a' };

const analyzer: ResourceAnalyzer = {
  analyze: async (input: AnalyzerInput) => {
    const text = new TextDecoder().decode(input.bytes);
    return {
      format: 'markdown',
      elementCount: text.split('\n').length,
      tableCount: 0,
      headings: ['Authentication Specification'],
      textPreview: text.slice(0, 100),
      truncated: false,
    };
  },
  summarize: async () => ({ summary: 'A short generated summary.', trustTag: 'ai_generated' }),
};

async function harness(grantsAll = true) {
  const registry = new ProviderRegistry();
  for (const provider of createMockConnectedAppProviders()) registry.register(provider);
  const manager = new ConnectedAppManager({ registry, vault: new InMemoryCredentialVault() });
  await manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
  await manager.connect(owner, 'github', {
    grantedScopes: ['repositories:read', 'contents:read'],
  });
  const intelligence = new ConnectedResourceIntelligence(manager, analyzer);
  const { definitions, implementations } = createConnectedAppTools(manager, intelligence, owner);
  const tools = new ToolManager();
  for (const definition of definitions) tools.register(definition);
  for (const implementation of implementations) tools.registerImplementation(implementation);
  if (grantsAll) {
    for (const definition of definitions)
      for (const permission of definition.requiredPermissions)
        tools.grantPermission(definition.id, permission);
  }
  return { manager, tools, definitions };
}

describe('connected-app tools', () => {
  it('declares read-only tools with strict schemas and a read permission', async () => {
    const { definitions } = await harness();
    expect(definitions.map((definition) => definition.id)).toEqual([
      'connections.list_accounts',
      'connections.list_resources',
      'connections.search_resources',
      'connections.resource_metadata',
      'connections.read_content',
      'connections.search_repository_files',
      'connections.read_file',
      'connections.summarize_resource',
      'connections.compare_resources',
      'connections.source_evidence',
    ]);
    for (const definition of definitions) {
      expect(definition.requiredPermissions).toEqual(['connections.read']);
      expect(definition.riskLevel).toBe('low');
      expect(definition.requiresConfirmation).toBe(false);
      expect(definition.inputSchema.type).toBe('object');
      expect(definition.outputSchema.type).toBe('object');
    }
  });

  it('lists connected accounts without exposing credentials', async () => {
    const { tools } = await harness();
    const result = await tools.invoke('connections.list_accounts', {}, { requester: 'test' });
    const body = result.output as { connections: { providerId: string; status: string }[] };
    expect(body.connections.map((connection) => connection.providerId).sort()).toEqual([
      'github',
      'notion',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/credential|token/i);
  });

  it('searches connected resources and returns provenance', async () => {
    const { tools } = await harness();
    const result = await tools.invoke(
      'connections.search_resources',
      {
        provider: 'notion',
        query: 'authentication',
      },
      { requester: 'test' },
    );
    const body = result.output as { resources: { resourceId: string }[] };
    expect(body.resources.map((resource) => resource.resourceId)).toContain('page:auth-spec');
  });

  it('reads authorized content and labels it as untrusted data', async () => {
    const { tools } = await harness();
    const result = await tools.invoke(
      'connections.read_file',
      {
        resourceId: 'file:acme/messenger:docs/architecture.md',
      },
      { requester: 'test' },
    );
    const body = result.output as { text: string; trustTag: string };
    expect(body.text).toContain('Authentication');
    // read-only output is untrusted data, labelled in the payload
    expect(body.trustTag).toBe('untrusted_data');
  });

  it('summarizes and compares connected resources', async () => {
    const { tools } = await harness();
    const summary = await tools.invoke(
      'connections.summarize_resource',
      {
        provider: 'notion',
        resourceId: 'page:auth-spec',
        mode: 'bullets',
      },
      { requester: 'test' },
    );
    const summaryOut = summary.output as { summary: string; trustTag: string };
    expect(summaryOut.summary).toBe('A short generated summary.');
    expect(summaryOut.trustTag).toBe('ai_generated');
    const compare = await tools.invoke(
      'connections.compare_resources',
      {
        leftProvider: 'notion',
        leftResourceId: 'page:auth-spec',
        rightProvider: 'notion',
        rightResourceId: 'page:onboarding',
      },
      { requester: 'test' },
    );
    expect((compare.output as { summary: string }).summary).toContain('structural comparison');
  });

  it('answers a disconnected provider with a typed tool error', async () => {
    const { tools } = await harness();
    const result = await tools.invoke(
      'connections.list_resources',
      { provider: 'google_drive' },
      { requester: 't' },
    );
    expect(result.status).toBe('failure');
    expect(result.error?.message).toMatch(/not connected/i);
  });

  it('rejects invalid input before any provider call', async () => {
    const { tools } = await harness();
    const badProvider = await tools.invoke(
      'connections.list_resources',
      { provider: 'dropbox' },
      { requester: 't' },
    );
    // invalid enum or missing required input is refused before execution
    expect(badProvider.status).toBe('denied');
    const missingId = await tools.invoke(
      'connections.read_content',
      { provider: 'notion' },
      { requester: 't' },
    );
    expect(missingId.status).toBe('denied');
  });
});

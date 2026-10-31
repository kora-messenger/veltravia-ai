// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CrossSourceSearch,
  IntelligenceEngine,
  SourceRegistry,
  createIntelligenceTools,
  createMockReasoningProvider,
} from './index.js';
import { createFixtureRegistry } from './fixtures/index.js';

function build() {
  const registry = new SourceRegistry();
  const fixtures = createFixtureRegistry();
  for (const entry of fixtures.adapters) registry.register(entry.adapter);
  const engine = new IntelligenceEngine({ registry, reasoning: createMockReasoningProvider() });
  const tools = createIntelligenceTools({
    engine,
    search: new CrossSourceSearch(registry),
    collectorFor: () => null,
    ownerRef: 'owner-a',
  });
  const run = async (id: string, input: Record<string, unknown>) => {
    for (const definition of tools.definitions) {
      if (definition.id !== id) continue;
      for (const permission of definition.requiredPermissions ?? [])
        expect(permission).toBe('intelligence.read');
    }
    const implementation = tools.implementations.find((item) => item.toolId === id);
    if (!implementation) throw new Error(`missing tool ${id}`);
    return implementation.handler(input);
  };
  return { tools, run };
}

describe('intelligence tools', () => {
  it('registers eight read-only tools with closed schemas', () => {
    const { tools } = build();
    expect(tools.definitions).toHaveLength(8);
    for (const definition of tools.definitions) {
      expect(definition.riskLevel).toBe('low');
      expect(definition.requiresConfirmation).toBe(false);
      expect(definition.requiredPermissions).toContain('intelligence.read');
      expect(definition.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('discovers sources for the bound owner only', async () => {
    const { run } = build();
    const result = (await run('intelligence.discover_sources', {})) as {
      sources: { sourceId: string }[];
    };
    expect(result.sources.length).toBe(4);
    expect(result.sources.every((source) => !source.sourceId.includes('doc-secret'))).toBe(true);
  });

  it('searches with provenance and no invented hits', async () => {
    const { run } = build();
    const result = (await run('intelligence.search', { query: 'deadline' })) as {
      hits: { sourceId: string; locator: string; revision: string }[];
    };
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.locator.length).toBeGreaterThan(0);
      expect(hit.revision.length).toBeGreaterThan(0);
    }
  });

  it('synthesizes an answer that carries its reasoning disclosure', async () => {
    const { run } = build();
    const result = (await run('intelligence.synthesize', {
      question: 'Find contradictions about the deadline',
    })) as { status: string; reasoning: { simulated: boolean; mode: string } };
    expect(result.status).not.toBe('no_evidence');
    expect(result.reasoning.simulated).toBe(true);
    expect(result.reasoning.mode).toBe('mock_reasoning');
  });

  it('retrieves evidence for a source without an analysis run', async () => {
    const { run } = build();
    const result = (await run('intelligence.evidence', {
      source_id: 'files:doc-requirements',
    })) as { evidence: { excerpt: string; locator: string }[] };
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0]!.locator.length).toBeGreaterThan(0);
  });

  it('compares two sources and reports conflicts', async () => {
    const { run } = build();
    const result = (await run('intelligence.compare', {
      source_ids: ['files:doc-requirements', 'google_drive:drive-implementation'],
    })) as { participants: unknown[]; contradictions: unknown[] };
    expect(result.participants).toHaveLength(2);
    expect(result.contradictions.length).toBeGreaterThan(0);
  });

  it('surfaces a typed error for an unreadable source', async () => {
    const { run } = build();
    await expect(
      run('intelligence.evidence', { source_id: 'files:doc-secret' }),
    ).rejects.toMatchObject({ details: { toolId: 'intelligence.evidence' } });
  });
});

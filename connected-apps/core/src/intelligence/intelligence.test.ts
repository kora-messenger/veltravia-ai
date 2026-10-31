import { describe, expect, it } from 'vitest';
import { createMockConnectedAppProviders } from '@veltravia/connected-apps-mock';
import {
  ConnectedAppManager,
  ConnectedResourceIntelligence,
  InMemoryCredentialVault,
  ProviderRegistry,
  type AnalyzerInput,
  type ResourceAnalyzer,
} from '../index.js';

const owner = { ownerRef: 'owner-a' };

class StubAnalyzer implements ResourceAnalyzer {
  readonly seen: AnalyzerInput[] = [];

  async analyze(input: AnalyzerInput) {
    this.seen.push(input);
    const text = new TextDecoder().decode(input.bytes);
    const headings = text
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#+\s*/, ''));
    return {
      format: input.mimeType.includes('markdown') ? 'markdown' : 'txt',
      elementCount: text.split('\n').filter(Boolean).length,
      tableCount: 0,
      headings,
      textPreview: text.slice(0, 200),
      truncated: false,
    };
  }

  async summarize(input: AnalyzerInput & { mode: string }) {
    const text = new TextDecoder().decode(input.bytes);
    return { summary: `${input.mode}: ${text.split('\n')[0]}`, trustTag: 'ai_generated' };
  }
}

async function harness() {
  const registry = new ProviderRegistry();
  for (const provider of createMockConnectedAppProviders()) registry.register(provider);
  const manager = new ConnectedAppManager({ registry, vault: new InMemoryCredentialVault() });
  await manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
  const analyzer = new StubAnalyzer();
  return { manager, intelligence: new ConnectedResourceIntelligence(manager, analyzer), analyzer };
}

describe('connected resource intelligence', () => {
  it('analyzes a connected resource and keeps its provenance', async () => {
    const { intelligence } = await harness();
    const result = await intelligence.analyze(owner, 'notion', 'page:auth-spec');
    expect(result.elementCount).toBeGreaterThan(0);
    expect(result.headings).toContain('Authentication Specification');
    expect(result.provenance.resourceName).toBe('Authentication Specification');
    expect(result.provenance.revision).toBe('page-auth-4');
    expect(result.fromCache).toBe(false);
  });

  it('labels summaries as AI-generated and reports freshness', async () => {
    const { intelligence, analyzer } = await harness();
    const result = await intelligence.summarize(owner, 'notion', 'page:auth-spec', 'bullets');
    expect(result.trustTag).toBe('ai_generated');
    expect(result.summary.startsWith('bullets:')).toBe(true);
    expect(result.ageSeconds).toBe(0);
    expect(analyzer.seen).toHaveLength(0); // summarize goes through summarize(), not analyze()
  });

  it('compares two resources structurally and says so', async () => {
    const { intelligence } = await harness();
    const compare = await intelligence.compare(
      owner,
      { providerId: 'notion', resourceId: 'page:auth-spec' },
      { providerId: 'notion', resourceId: 'page:onboarding' },
    );
    expect(compare.summary).toContain('structural comparison only');
    expect(compare.left.provenance.resourceId).toBe('page:auth-spec');
    expect(compare.right.provenance.resourceId).toBe('page:onboarding');
    expect(Array.isArray(compare.sharedHeadings)).toBe(true);
  });

  it('refuses to analyze when the connection lacks the scope', async () => {
    const { intelligence, manager } = await harness();
    await manager.connect(owner, 'google_drive', { grantedScopes: ['drive.metadata.readonly'] });
    await expect(
      intelligence.analyze(owner, 'google_drive', 'drive:roadmap.md'),
    ).rejects.toMatchObject({ code: 'CONNECTED_INSUFFICIENT_SCOPE' });
  });

  it('does not call the analyzer when the provider refuses the resource', async () => {
    const registry = new ProviderRegistry();
    for (const provider of createMockConnectedAppProviders()) registry.register(provider);
    const manager = new ConnectedAppManager({ registry, vault: new InMemoryCredentialVault() });
    await manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    const analyzer = new StubAnalyzer();
    const intelligence = new ConnectedResourceIntelligence(manager, analyzer);
    await expect(intelligence.analyze(owner, 'notion', 'page:missing')).rejects.toMatchObject({
      code: 'CONNECTED_RESOURCE_NOT_FOUND',
    });
    expect(analyzer.seen).toHaveLength(0);
  });

  it('maps an analyzer failure to a typed parse error without leaking internals', async () => {
    const registry = new ProviderRegistry();
    for (const provider of createMockConnectedAppProviders()) registry.register(provider);
    const manager = new ConnectedAppManager({ registry, vault: new InMemoryCredentialVault() });
    await manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    const broken: ResourceAnalyzer = {
      analyze: async () => {
        throw new Error('parser exploded at offset 42');
      },
      summarize: async () => ({ summary: '', trustTag: 'ai_generated' }),
    };
    const intelligence = new ConnectedResourceIntelligence(manager, broken);
    await expect(intelligence.analyze(owner, 'notion', 'page:auth-spec')).rejects.toMatchObject({
      code: 'CONNECTED_PARSE_FAILED',
    });
  });
});

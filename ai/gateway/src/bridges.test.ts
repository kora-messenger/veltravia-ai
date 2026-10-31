import { describe, expect, it } from 'vitest';

import { AIProviderGateway } from './gateway/index.js';
import { CredentialVault } from './vault/index.js';
import { InMemoryConnectionStore, InMemoryPreferenceStore } from './store/index.js';
import { InMemoryUsageStore } from './usage/index.js';
import {
  createGatewayCodingDecisionSource,
  createGatewayDecisionSource,
  createGatewayDocumentProvider,
  createGatewaySynthesisProvider,
  extractJsonObject,
  isNoProviderError,
} from './bridges/index.js';
import { FixtureProviderTransport, TEST_OPENAI_KEY, createTestKeyring } from '../mock/src/index.js';

async function gatewayWith(content: string) {
  const gateway = new AIProviderGateway({
    vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage: new InMemoryUsageStore(),
    transport: new FixtureProviderTransport({ content, models: ['gpt-a'] }),
    resolveHost: async () => ['93.184.216.34'],
  });
  await gateway.createConnection(
    { ownerRef: 'owner-a' },
    { providerId: 'openai', apiKey: TEST_OPENAI_KEY, modelIds: ['gpt-a'], skipDiscovery: true },
  );
  return gateway;
}

const scope = { ownerRef: 'owner-a' };

describe('reasoning bridges', () => {
  it('parses a decision object out of fenced model text', () => {
    expect(extractJsonObject('```json\n{"type":"stop"}\n```')).toEqual({ type: 'stop' });
    expect(extractJsonObject('not json')).toEqual({});
    expect(extractJsonObject(undefined)).toEqual({});
  });

  it('agent bridge returns an accepted answer decision', async () => {
    const gateway = await gatewayWith('{"type":"answer","output":"Done."}');
    const source = createGatewayDecisionSource({ gateway, scope });
    const decision = await source.decide({ transcript: 'user: hi' });
    expect(decision).toEqual({ type: 'answer', output: 'Done.' });
  });

  it('agent bridge refuses a tool the platform did not offer', async () => {
    const gateway = await gatewayWith(
      '{"type":"request_tool","toolId":"files.delete-all","input":{}}',
    );
    const source = createGatewayDecisionSource({ gateway, scope });
    const decision = await source.decide({
      transcript: 'user: hi',
      availableTools: ['project.read-file'],
    });
    expect(decision.type).toBe('fail');
  });

  it('agent bridge fails honestly on an unparseable decision', async () => {
    const gateway = await gatewayWith('I would rather chat.');
    const source = createGatewayDecisionSource({ gateway, scope });
    const decision = await source.decide({ transcript: 'hi' });
    expect(decision.type).toBe('fail');
  });

  it('agent bridge surfaces "no provider configured" distinguishably', async () => {
    const gateway = new AIProviderGateway({
      vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
      connections: new InMemoryConnectionStore(),
      preferences: new InMemoryPreferenceStore(),
      usage: new InMemoryUsageStore(),
      transport: new FixtureProviderTransport(),
    });
    const source = createGatewayDecisionSource({ gateway, scope });
    const error = await source.decide({ transcript: 'hi' }).catch((caught: unknown) => caught);
    expect(isNoProviderError(error)).toBe(true);
  });

  it('coding bridge accepts an offered tool and refuses an invented one', async () => {
    const gateway = await gatewayWith(
      '{"type":"request_tool","toolId":"project.read-file","input":{"path":"a.ts"}}',
    );
    const source = createGatewayCodingDecisionSource({ gateway, scope });
    const ok = await source.nextDecision({
      instructions: 'inspect',
      availableTools: ['project.read-file'],
    });
    expect(ok).toMatchObject({ type: 'request_tool', toolId: 'project.read-file' });

    const gateway2 = await gatewayWith(
      '{"type":"request_tool","toolId":"sandbox.shell","input":{}}',
    );
    const refused = await createGatewayCodingDecisionSource({
      gateway: gateway2,
      scope,
    }).nextDecision({
      availableTools: ['project.read-file'],
    });
    expect(refused).toMatchObject({ type: 'fail' });
  });

  it('document bridge forwards provider JSON text and refuses unknown operations', async () => {
    const gateway = await gatewayWith('{"answer":"Forty pages.","evidence":[]}');
    const provider = createGatewayDocumentProvider({ gateway, scope });
    expect(provider.getCapabilities().capabilities).toContain('question_answering');
    const raw = await provider.process({
      operation: 'question_answering',
      structure: { elements: [] },
      input: { question: 'how long?' },
    });
    expect(JSON.parse(raw).answer).toBe('Forty pages.');
    await expect(
      provider.process({ operation: 'summarization_of_everything', structure: {}, input: {} }),
    ).rejects.toBeTruthy();
  });

  it('synthesis bridge discloses a real provider and returns provider text', async () => {
    const gateway = await gatewayWith('{"summary":"Both sources agree.","claims":[]}');
    const provider = createGatewaySynthesisProvider({ gateway, scope });
    const disclosure = provider.disclosure();
    expect(disclosure.simulated).toBe(false);
    const raw = await provider.compose({
      question: 'what changed?',
      evidence: [{ id: 'e1', text: 'evidence' }],
      segments: [],
      contradictions: [],
    });
    expect(JSON.parse(raw).summary).toBe('Both sources agree.');
  });
});

import { describe, expect, it } from 'vitest';

import { manifestToIntegrationDefinition, validateIntegrationManifest } from './index.js';
import { validIntegrationDefinition as validDefinition } from '../testing/index.js';

/** A minimal VALID v1 manifest (mirrors the integration definition shape). */
function validManifest(): Record<string, unknown> {
  return {
    manifestVersion: '1',
    integration: {
      id: 'demo-store',
      name: 'Demo Store',
      description: 'A deterministic offline object store.',
      version: '1.0.0',
      publisher: 'Veltravia',
      category: 'storage',
      authenticationType: 'api_key',
      capabilities: ['read', 'write'],
      scopes: [{ id: 'storage.objects.read', description: 'Read objects.', riskLevel: 'low' }],
      tools: [
        {
          id: 'storage.object.get',
          name: 'Get Object',
          description: 'Reads one object.',
          operationId: 'storage.objects.get',
          requiredScopes: ['storage.objects.read'],
          riskLevel: 'low',
          requiresConfirmation: false,
        },
      ],
      environments: ['development'],
    },
  };
}

describe('validateIntegrationManifest', () => {
  it('accepts a valid v1 manifest', () => {
    expect(validateIntegrationManifest(validManifest())).toEqual({ valid: true, reasons: [] });
  });

  it('rejects a non-object manifest', () => {
    expect(validateIntegrationManifest('hello').valid).toBe(false);
    expect(validateIntegrationManifest(null).valid).toBe(false);
    expect(validateIntegrationManifest([]).valid).toBe(false);
  });

  it('rejects an unsupported manifest version', () => {
    const manifest = { ...validManifest(), manifestVersion: '2' };
    const result = validateIntegrationManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/manifestVersion/);
  });

  it('rejects unknown top-level fields (strict contract)', () => {
    const manifest = { ...validManifest(), extraCapability: {} };
    const result = validateIntegrationManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/extraCapability/);
  });

  it('rejects executable/code-shaped fields anywhere in the manifest', () => {
    for (const forbidden of ['code', 'entry', 'script', 'hooks', 'install', 'url']) {
      const manifest = validManifest();
      (manifest['integration'] as Record<string, unknown>)[forbidden] = 'do-something';
      const result = validateIntegrationManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.reasons.join(' ')).toMatch(new RegExp(forbidden));
    }
  });

  it('rejects secret-shaped values inside the manifest', () => {
    const manifest = validManifest();
    (manifest['integration'] as Record<string, unknown>)['description'] =
      'Uses key sk-ant-api03-RAWSECRET9876543210';
    const result = validateIntegrationManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/secret-shaped/);
  });
});

describe('manifestToIntegrationDefinition', () => {
  it('converts a valid manifest into a catalog definition', () => {
    const definition = manifestToIntegrationDefinition(validManifest());
    expect(definition.id).toBe('demo-store');
    expect(definition.scopes).toHaveLength(1);
    expect(definition.tools[0]?.id).toBe('storage.object.get');
  });

  it('rejects an invalid manifest with the typed error', () => {
    expect(() =>
      manifestToIntegrationDefinition({ ...validManifest(), manifestVersion: '9' }),
    ).toThrow(/Invalid integration/);
  });

  it('audits rejections when a sink is provided', () => {
    const events: { type: string }[] = [];
    expect(() =>
      manifestToIntegrationDefinition(
        {
          ...validManifest(),
          integration: { ...(validManifest()['integration'] as object), code: 'x' },
        },
        { onAudit: (event) => events.push({ type: event.type }) },
      ),
    ).toThrow();
    expect(events.some((event) => event.type === 'integration.manifest_rejected')).toBe(true);
  });

  it('manifest definitions carry no executable material (structural)', () => {
    const definition = manifestToIntegrationDefinition(validManifest());
    const serialized = JSON.stringify(definition);
    expect(serialized).not.toMatch(/\b(code|entry|script|hooks|install)\b/i);
  });

  it('round-trips the same contract as first-party definitions', () => {
    const firstParty = validDefinition();
    const definition = manifestToIntegrationDefinition(validManifest());
    expect(definition.id).toBe(firstParty.id);
    expect(definition.authenticationType).toBe(firstParty.authenticationType);
  });
});

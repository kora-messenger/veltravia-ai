import type { IntegrationDefinition } from '../types/integration.js';

/**
 * Testing fixtures: a minimal VALID integration definition used as the
 * base for tests across the package (and the mock bundles' tests).
 * Exported from a non-test module so importing it never re-registers
 * another file's describe blocks.
 */
export function validIntegrationDefinition(): IntegrationDefinition {
  return {
    id: 'demo-store',
    name: 'Demo Store',
    description: 'A deterministic offline object store used to prove the integration model.',
    version: '1.0.0',
    publisher: 'Veltravia',
    category: 'storage',
    authenticationType: 'api_key',
    capabilities: ['read', 'write'],
    scopes: [
      { id: 'storage.objects.read', description: 'Read stored objects.', riskLevel: 'low' },
      { id: 'storage.objects.write', description: 'Write stored objects.', riskLevel: 'medium' },
      { id: 'storage.objects.delete', description: 'Delete stored objects.', riskLevel: 'high' },
    ],
    tools: [
      {
        id: 'storage.object.get',
        name: 'Get Object',
        description: 'Reads one stored object.',
        operationId: 'storage.objects.get',
        requiredScopes: ['storage.objects.read'],
        riskLevel: 'low',
        requiresConfirmation: false,
      },
      {
        id: 'storage.object.put',
        name: 'Put Object',
        description: 'Writes one stored object.',
        operationId: 'storage.objects.put',
        requiredScopes: ['storage.objects.write'],
        riskLevel: 'medium',
        requiresConfirmation: false,
      },
      {
        id: 'storage.object.delete',
        name: 'Delete Object',
        description: 'Deletes one stored object.',
        operationId: 'storage.objects.delete',
        requiredScopes: ['storage.objects.delete'],
        riskLevel: 'high',
        requiresConfirmation: false,
      },
    ],
    environments: ['development'],
  };
}

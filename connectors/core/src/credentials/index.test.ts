import { describe, expect, it } from 'vitest';
import { createCredentialReference } from './index.js';

describe('CredentialReference', () => {
  it('creates a metadata-only reference for a secret held elsewhere', () => {
    const reference = createCredentialReference({
      credentialId: 'cred_01H8Z9',
      credentialType: 'api_key',
      providerRef: 'vault:kv/veltravia/future-connector',
      createdAt: '2026-09-13T12:00:00.000Z',
    });
    expect(reference).toEqual({
      credentialId: 'cred_01H8Z9',
      credentialType: 'api_key',
      providerRef: 'vault:kv/veltravia/future-connector',
      status: 'pending',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    });
  });

  it('has NO field capable of carrying a raw secret value', () => {
    const reference = createCredentialReference({
      credentialId: 'c1',
      credentialType: 'oauth_token',
      providerRef: 'env:EXAMPLE',
    });
    const keys = Object.keys(reference);
    expect(keys).toEqual([
      'credentialId',
      'credentialType',
      'providerRef',
      'status',
      'createdAt',
      'updatedAt',
    ]);
    for (const forbidden of ['value', 'token', 'secret', 'key', 'password']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('validates its inputs', () => {
    expect(() =>
      createCredentialReference({
        credentialId: '',
        credentialType: 'api_key',
        providerRef: 'env:X',
      }),
    ).toThrow();
    expect(() =>
      createCredentialReference({
        credentialId: 'c1',
        credentialType: 'carrier-pigeon' as never,
        providerRef: 'env:X',
      }),
    ).toThrow(/credentialType/);
    expect(() =>
      createCredentialReference({
        credentialId: 'c1',
        credentialType: 'api_key',
        providerRef: '  ',
      }),
    ).toThrow(/providerRef/);
    expect(() =>
      createCredentialReference({
        credentialId: 'c1',
        credentialType: 'api_key',
        providerRef: 'env:X',
        status: 'dreaming' as never,
      }),
    ).toThrow(/status/);
  });
});

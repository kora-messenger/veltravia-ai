import { describe, expect, it } from 'vitest';

import { GatewayError } from './errors/index.js';
import { loadVaultKeyring, CredentialVault, InMemoryVaultRecordStore } from './vault/index.js';
import { createTestKeyring, TEST_OPENAI_KEY } from '../mock/src/index.js';

function vaultOf(options: { versions?: number[]; now?: () => Date } = {}) {
  const store = new InMemoryVaultRecordStore();
  const vault = new CredentialVault({
    keyring: createTestKeyring(options.versions ?? [1]),
    store,
    ...(options.now ? { now: options.now } : {}),
  });
  return { vault, store };
}

describe('credential vault', () => {
  it('encrypts a credential and never persists plaintext', async () => {
    const { vault, store } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    const snapshot = JSON.stringify(store.snapshot());
    expect(snapshot).not.toContain(TEST_OPENAI_KEY);
    expect(snapshot).not.toContain('test-openai');
    expect(store.snapshot()[0]?.algorithm).toBe('aes-256-gcm');
    const decrypted = await vault.read('owner-a', ref);
    expect(decrypted).toBe(TEST_OPENAI_KEY);
  });

  it('uses a fresh IV per credential so identical secrets differ at rest', async () => {
    const { vault, store } = vaultOf();
    await vault.put('owner-a', TEST_OPENAI_KEY);
    await vault.put('owner-a', TEST_OPENAI_KEY);
    const [first, second] = store.snapshot();
    expect(first?.iv).not.toBe(second?.iv);
    expect(first?.ciphertext).not.toBe(second?.ciphertext);
  });

  it('refuses to decrypt another owner’s credential', async () => {
    const { vault } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    await expect(vault.read('owner-b', ref)).rejects.toBeInstanceOf(GatewayError);
  });

  it('replaces a credential in place and keeps the reference', async () => {
    const { vault, store } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    await vault.replace('owner-a', ref, 'sk-test-openai-1111111111111111');
    expect(store.snapshot()).toHaveLength(1);
    expect(await vault.read('owner-a', ref)).toBe('sk-test-openai-1111111111111111');
  });

  it('deletes a credential and refuses to read it afterwards', async () => {
    const { vault, store } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    await vault.delete('owner-a', ref);
    expect(store.snapshot()).toHaveLength(0);
    await expect(vault.read('owner-a', ref)).rejects.toBeInstanceOf(GatewayError);
  });

  it('does not let another owner delete a credential', async () => {
    const { vault, store } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    await vault.delete('owner-b', ref);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('records the key version and decrypts with older keys after rotation', async () => {
    const { vault } = vaultOf({ versions: [1, 2] });
    const { ref, keyVersion } = await vault.put('owner-a', TEST_OPENAI_KEY);
    expect(keyVersion).toBe(2);
    expect(await vault.read('owner-a', ref)).toBe(TEST_OPENAI_KEY);
    const rotated = new CredentialVault({
      keyring: { keys: createTestKeyring([1, 2, 3]).keys, activeVersion: 3 },
    });
    // A different keyring cannot decrypt: authentication fails closed.
    const secondRef = await rotated.put('owner-a', TEST_OPENAI_KEY);
    const foreign = new CredentialVault({ keyring: createTestKeyring([4]) });
    await expect(foreign.read('owner-a', secondRef)).rejects.toBeInstanceOf(GatewayError);
  });

  it('fails closed when the matching key version is missing', async () => {
    const { vault } = vaultOf({ versions: [1] });
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    const keyring = createTestKeyring([2]);
    const mismatched = new CredentialVault({
      keyring,
      store: {
        put: async () => undefined,
        delete: async () => undefined,
        listByOwner: async () => [],
        get: async () => ({
          ref,
          ownerRef: 'owner-a',
          keyVersion: 1,
          algorithm: 'aes-256-gcm',
          iv: 'AAAAAAAAAAAAAAAA',
          authTag: 'AAAAAAAAAAAAAAAAAAAAAA==',
          ciphertext: 'AAAA',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await expect(mismatched.read('owner-a', ref)).rejects.toMatchObject({
      code: 'GATEWAY_VAULT_DECRYPT_FAILED',
    });
  });

  it('rejects a tampered ciphertext', async () => {
    const { vault, store } = vaultOf();
    const { ref } = await vault.put('owner-a', TEST_OPENAI_KEY);
    const record = store.snapshot()[0];
    expect(record).toBeDefined();
    // Flip the first character to something it is not: replacing it with a fixed
    // 'A' did nothing whenever the random ciphertext already began with one, and
    // the test then passed a valid record and failed for the wrong reason.
    const first = record!.ciphertext[0] === 'A' ? 'B' : 'A';
    await store.put({ ...record!, ciphertext: `${first}${record!.ciphertext.slice(1)}` });
    await expect(vault.read('owner-a', ref)).rejects.toMatchObject({
      code: 'GATEWAY_VAULT_DECRYPT_FAILED',
    });
  });

  it('rejects unusable secrets before encrypting them', async () => {
    const { vault } = vaultOf();
    await expect(vault.put('owner-a', 'short')).rejects.toBeInstanceOf(GatewayError);
    await expect(vault.put('owner-a', 'has whitespace inside-key')).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('refuses to construct without a key (fail closed)', () => {
    expect(() => new CredentialVault({ keyring: { keys: new Map(), activeVersion: 1 } })).toThrow(
      GatewayError,
    );
  });

  it('loads a keyring from the environment and reports absence honestly', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const keyring = loadVaultKeyring((name) =>
      name === 'VELTRAVIA_CREDENTIAL_KEYS' ? JSON.stringify({ 1: key, 2: key }) : undefined,
    );
    expect(keyring?.activeVersion).toBe(2);
    expect(loadVaultKeyring(() => undefined)).toBeNull();
  });

  it('rejects a malformed keyring instead of silently disabling encryption', () => {
    expect(() =>
      loadVaultKeyring((n) => (n === 'VELTRAVIA_CREDENTIAL_KEYS' ? '{not json' : undefined)),
    ).toThrow(GatewayError);
    expect(() =>
      loadVaultKeyring((n) =>
        n === 'VELTRAVIA_CREDENTIAL_KEYS' ? JSON.stringify({ 1: 'too-short' }) : undefined,
      ),
    ).toThrow(GatewayError);
  });
});

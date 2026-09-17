import { describe, expect, it } from 'vitest';

import { InMemorySecretStore } from './index.js';

const RAW = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

describe('InMemorySecretStore', () => {
  it('stores, reads, and deletes secrets', () => {
    const store = new InMemorySecretStore();
    const ref = { integrationId: 'github', secretId: 'operator' };
    expect(store.hasSecret(ref)).toBe(false);
    store.setSecret(ref, RAW);
    expect(store.hasSecret(ref)).toBe(true);
    expect(store.getSecret(ref)).toBe(RAW);
    store.deleteSecret(ref);
    expect(store.hasSecret(ref)).toBe(false);
    expect(store.getSecret(ref)).toBeUndefined();
  });

  it('keeps secrets isolated per integration + secret id', () => {
    const store = new InMemorySecretStore();
    store.setSecret({ integrationId: 'github', secretId: 'a' }, 'github-a');
    store.setSecret({ integrationId: 'storage', secretId: 'a' }, 'storage-a');
    expect(store.getSecret({ integrationId: 'github', secretId: 'a' })).toBe('github-a');
    expect(store.getSecret({ integrationId: 'storage', secretId: 'a' })).toBe('storage-a');
  });

  it('rejects empty secret values', () => {
    const store = new InMemorySecretStore();
    expect(() => store.setSecret({ integrationId: 'x', secretId: 'y' }, '')).toThrow();
  });

  it('describes refs only - values can never surface through the diagnostic path', () => {
    const store = new InMemorySecretStore();
    store.setSecret({ integrationId: 'github', secretId: 'operator' }, RAW);
    const described = store.describe();
    expect(described).toEqual([{ integrationId: 'github', secretId: 'operator' }]);
    expect(JSON.stringify(described)).not.toContain(RAW);
  });
});

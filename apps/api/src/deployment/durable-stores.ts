import type {
  ConnectionStore,
  EncryptedCredentialRecord,
  PreferenceStore,
  ProviderConnection,
  ProviderPreferences,
  UsageRecord,
  UsageStore,
  VaultRecordStore,
} from '@veltravia/ai-gateway';
import { JsonCollection } from './durable-store.js';

/**
 * File-backed adapters for the four gateway ports.
 *
 * They implement the ports the gateway already declares, so the gateway, the
 * routes and the UI are untouched: switching from memory to disk is one option,
 * not a rewrite. Credentials stay encrypted inside the vault; what lands here is
 * the vault's own encrypted record, never a plaintext key.
 */

export interface DurableGatewayStores {
  readonly vault: VaultRecordStore;
  readonly connections: ConnectionStore;
  readonly preferences: PreferenceStore;
  readonly usage: UsageStore;
  readonly verify: () => Promise<void>;
}

interface OwnedRecord {
  readonly ownerRef: string;
}

const USAGE_CAP = 5000;
const CREDENTIAL_CAP = 500;
const CONNECTION_CAP = 500;

export function createDurableGatewayStores(dir: string): DurableGatewayStores {
  const credentials = new JsonCollection<EncryptedCredentialRecord>({
    dir,
    name: 'provider-credentials',
    keyOf: (record) => record.ref,
    maxRecords: CREDENTIAL_CAP,
  });
  const connections = new JsonCollection<ProviderConnection>({
    dir,
    name: 'provider-connections',
    keyOf: (record) => record.id,
    maxRecords: CONNECTION_CAP,
  });
  const preferences = new JsonCollection<ProviderPreferences & OwnedRecord>({
    dir,
    name: 'provider-preferences',
    keyOf: (record) => record.ownerRef,
    maxRecords: CONNECTION_CAP,
  });
  const usage = new JsonCollection<UsageRecord & OwnedRecord>({
    dir,
    name: 'usage-records',
    keyOf: (record) => `${record.ownerRef}:${record.id}`,
    maxRecords: USAGE_CAP,
  });

  const vault: VaultRecordStore = {
    async put(record) {
      await credentials.put(record);
    },
    async get(ref) {
      return credentials.get(ref);
    },
    async delete(ref) {
      await credentials.delete(ref);
    },
    async listByOwner(ownerRef) {
      return (await credentials.readAll()).filter((record) => record.ownerRef === ownerRef);
    },
  };

  const connectionStore: ConnectionStore = {
    async put(connection) {
      await connections.put(connection);
    },
    async get(id) {
      return connections.get(id);
    },
    async delete(id) {
      await connections.delete(id);
    },
    async listByOwner(ownerRef) {
      return (await connections.readAll()).filter((record) => record.ownerRef === ownerRef);
    },
  };

  const preferenceStore: PreferenceStore = {
    async get(ownerRef) {
      return preferences.get(ownerRef);
    },
    async put(value) {
      await preferences.put(value as ProviderPreferences & OwnedRecord);
    },
    async delete(ownerRef) {
      await preferences.delete(ownerRef);
    },
  };

  const usageStore: UsageStore = {
    async record(entry) {
      await usage.put(entry as UsageRecord & OwnedRecord);
    },
    async listByOwner(ownerRef, limit) {
      const owned = (await usage.readAll())
        .filter((record) => record.ownerRef === ownerRef)
        .reverse();
      return limit === undefined ? owned : owned.slice(0, limit);
    },
  };

  return {
    vault,
    connections: connectionStore,
    preferences: preferenceStore,
    usage: usageStore,
    async verify() {
      await Promise.all([
        credentials.verifyWritable(),
        connections.verifyWritable(),
        preferences.verifyWritable(),
        usage.verifyWritable(),
      ]);
    },
  };
}

import type { ProviderConnection, ProviderPreferences } from '../types/index.js';

/**
 * Persistence ports for gateway state. Development uses the in-memory
 * implementations below; a deployment swaps in a durable store without touching
 * the gateway, the API or the UI. Credentials are NOT here - they live in the
 * vault, referenced by `credentialRef`.
 */
export interface ConnectionStore {
  put(connection: ProviderConnection): Promise<void>;
  get(id: string): Promise<ProviderConnection | undefined>;
  delete(id: string): Promise<void>;
  listByOwner(ownerRef: string): Promise<readonly ProviderConnection[]>;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly connections = new Map<string, ProviderConnection>();

  async put(connection: ProviderConnection): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  async get(id: string): Promise<ProviderConnection | undefined> {
    return this.connections.get(id);
  }

  async delete(id: string): Promise<void> {
    this.connections.delete(id);
  }

  async listByOwner(ownerRef: string): Promise<readonly ProviderConnection[]> {
    return [...this.connections.values()].filter((connection) => connection.ownerRef === ownerRef);
  }
}

export interface PreferenceStore {
  get(ownerRef: string): Promise<ProviderPreferences | undefined>;
  put(preferences: ProviderPreferences): Promise<void>;
  delete(ownerRef: string): Promise<void>;
}

export class InMemoryPreferenceStore implements PreferenceStore {
  private readonly preferences = new Map<string, ProviderPreferences>();

  async get(ownerRef: string): Promise<ProviderPreferences | undefined> {
    return this.preferences.get(ownerRef);
  }

  async put(preferences: ProviderPreferences): Promise<void> {
    this.preferences.set(preferences.ownerRef, preferences);
  }

  async delete(ownerRef: string): Promise<void> {
    this.preferences.delete(ownerRef);
  }
}

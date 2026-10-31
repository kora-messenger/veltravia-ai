/** Connection records and the credential vault boundary. A connection stores a
 *  credential REFERENCE only; values live in the vault and never in a view, an
 *  audit record, or any response. */
import type { ConnectedAccount, ConnectedProviderId } from '../types/index.js';

export interface CredentialVault {
  put(ref: string, secret: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
}

/** Development-only in-process vault. Values are held in memory for the life of
 *  the process and never written to disk or logs. Not a production secret store. */
export class InMemoryCredentialVault implements CredentialVault {
  readonly #values = new Map<string, string>();

  put(ref: string, secret: string): void {
    if (!ref || !secret) throw new Error('A credential reference and value are required.');
    this.#values.set(ref, secret);
  }

  get(ref: string): string | null {
    return this.#values.get(ref) ?? null;
  }

  delete(ref: string): void {
    this.#values.delete(ref);
  }

  get size(): number {
    return this.#values.size;
  }
}

export interface ConnectionRecord {
  readonly account: ConnectedAccount;
  readonly credentialRef: string | null;
}

export class ConnectionStore {
  readonly #byOwner = new Map<string, Map<ConnectedProviderId, ConnectionRecord>>();

  put(ownerRef: string, record: ConnectionRecord): void {
    const owner = ownerRef;
    const existing = this.#byOwner.get(owner) ?? new Map<ConnectedProviderId, ConnectionRecord>();
    existing.set(record.account.providerId, record);
    this.#byOwner.set(owner, existing);
  }

  get(ownerRef: string, providerId: ConnectedProviderId): ConnectionRecord | null {
    return this.#byOwner.get(ownerRef)?.get(providerId) ?? null;
  }

  list(ownerRef: string): readonly ConnectionRecord[] {
    return [...(this.#byOwner.get(ownerRef)?.values() ?? [])].sort((a, b) =>
      a.account.providerName.localeCompare(b.account.providerName),
    );
  }

  remove(ownerRef: string, providerId: ConnectedProviderId): ConnectionRecord | null {
    const owner = this.#byOwner.get(ownerRef);
    const record = owner?.get(providerId) ?? null;
    owner?.delete(providerId);
    return record;
  }
}

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

import { readEnv } from '@veltravia/config';

import { GatewayError } from '../errors/index.js';

/**
 * The server-side credential vault (Step 26).
 *
 * Guarantees:
 *   - plaintext secrets exist only in memory, only between `read` and the
 *     provider request that needs them;
 *   - what is persisted is AES-256-GCM ciphertext with its IV, auth tag and
 *     the key VERSION that produced it (so keys can be rotated later);
 *   - the master key lives in the environment (or a secrets manager), never in
 *     the record store and never in the repo;
 *   - when no key is configured the vault fails CLOSED: putting a credential
 *     throws instead of silently storing plaintext;
 *   - a ciphertext that fails authentication is reported as a decryption
 *     failure, never as "wrong key guess" detail.
 */

export const VAULT_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** What is persisted per credential. Contains no plaintext. */
export interface EncryptedCredentialRecord {
  readonly ref: string;
  readonly ownerRef: string;
  readonly keyVersion: number;
  readonly algorithm: typeof VAULT_ALGORITHM;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Persistence port. In development this is in-memory; a deployment supplies
 *  a durable store without changing anything else. */
export interface VaultRecordStore {
  put(record: EncryptedCredentialRecord): Promise<void>;
  get(ref: string): Promise<EncryptedCredentialRecord | undefined>;
  delete(ref: string): Promise<void>;
  listByOwner(ownerRef: string): Promise<readonly EncryptedCredentialRecord[]>;
}

export class InMemoryVaultRecordStore implements VaultRecordStore {
  private readonly records = new Map<string, EncryptedCredentialRecord>();

  async put(record: EncryptedCredentialRecord): Promise<void> {
    this.records.set(record.ref, record);
  }

  async get(ref: string): Promise<EncryptedCredentialRecord | undefined> {
    return this.records.get(ref);
  }

  async delete(ref: string): Promise<void> {
    this.records.delete(ref);
  }

  async listByOwner(ownerRef: string): Promise<readonly EncryptedCredentialRecord[]> {
    return [...this.records.values()].filter((record) => record.ownerRef === ownerRef);
  }

  /** Test/diagnostic helper: proves no plaintext is persisted. */
  snapshot(): readonly EncryptedCredentialRecord[] {
    return [...this.records.values()];
  }
}

/** A keyring: key version -> raw 32-byte key. */
export interface VaultKeyring {
  readonly keys: ReadonlyMap<number, Buffer>;
  /** Version used for new encryptions (the newest configured version). */
  readonly activeVersion: number;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Accept base64 (preferred) or hex; both must yield exactly 32 bytes.
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  try {
    candidates.push(Buffer.from(trimmed, 'base64'));
  } catch {
    /* ignore */
  }
  const usable = candidates.find((buffer) => buffer.length === KEY_BYTES);
  if (!usable) {
    throw new GatewayError(
      'GATEWAY_VAULT_UNAVAILABLE',
      'The credential encryption key is not a 32-byte key (base64 or hex).',
    );
  }
  return usable;
}

/**
 * Loads the keyring from the environment:
 *   VELTRAVIA_CREDENTIAL_KEYS='{"1":"<base64>","2":"<base64>"}'   (preferred)
 *   VELTRAVIA_CREDENTIAL_KEY=<base64>                             (single key)
 *   VELTRAVIA_CREDENTIAL_KEY_VERSION=<n>                          (active version)
 *
 * Returns null when nothing is configured, so callers can fail closed with a
 * clear message instead of pretending encryption is on.
 */
export function loadVaultKeyring(
  env: (key: string) => string | undefined = (key) => readEnv(key),
): VaultKeyring | null {
  const keys = new Map<number, Buffer>();
  const json = env('VELTRAVIA_CREDENTIAL_KEYS');
  if (json && json.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new GatewayError(
        'GATEWAY_VAULT_UNAVAILABLE',
        'VELTRAVIA_CREDENTIAL_KEYS must be a JSON object of version to key.',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GatewayError(
        'GATEWAY_VAULT_UNAVAILABLE',
        'VELTRAVIA_CREDENTIAL_KEYS must be a JSON object of version to key.',
      );
    }
    for (const [version, value] of Object.entries(parsed as Record<string, unknown>)) {
      const numeric = Number(version);
      if (!Number.isInteger(numeric) || numeric < 1 || typeof value !== 'string') {
        throw new GatewayError(
          'GATEWAY_VAULT_UNAVAILABLE',
          'Key versions must be positive integers.',
        );
      }
      keys.set(numeric, decodeKey(value));
    }
  }
  const single = env('VELTRAVIA_CREDENTIAL_KEY');
  if (keys.size === 0 && single && single.trim().length > 0) {
    keys.set(Number(env('VELTRAVIA_CREDENTIAL_KEY_VERSION') ?? '1') || 1, decodeKey(single));
  }
  if (keys.size === 0) return null;
  const requested = Number(env('VELTRAVIA_CREDENTIAL_KEY_VERSION') ?? '');
  const versions = [...keys.keys()].sort((a, b) => a - b);
  const activeVersion =
    Number.isInteger(requested) && keys.has(requested)
      ? requested
      : (versions[versions.length - 1] as number);
  return { keys, activeVersion };
}

export interface CredentialVaultOptions {
  readonly keyring: VaultKeyring;
  readonly store?: VaultRecordStore;
  readonly now?: () => Date;
  readonly newRef?: () => string;
}

export interface StoredCredentialRef {
  readonly ref: string;
  readonly keyVersion: number;
}

export class CredentialVault {
  private readonly keyring: VaultKeyring;
  private readonly store: VaultRecordStore;
  private readonly now: () => Date;
  private readonly newRef: () => string;

  constructor(options: CredentialVaultOptions) {
    if (!options.keyring || options.keyring.keys.size === 0) {
      throw new GatewayError(
        'GATEWAY_VAULT_UNAVAILABLE',
        'No credential encryption key is configured; refusing to store credentials.',
      );
    }
    this.keyring = options.keyring;
    this.store = options.store ?? new InMemoryVaultRecordStore();
    this.now = options.now ?? (() => new Date());
    this.newRef = options.newRef ?? (() => `cred_${randomUUID()}`);
  }

  get recordStore(): VaultRecordStore {
    return this.store;
  }

  get activeKeyVersion(): number {
    return this.keyring.activeVersion;
  }

  /** Encrypts and persists a credential. Returns only the reference. */
  async put(ownerRef: string, secret: string): Promise<StoredCredentialRef> {
    assertUsableSecret(secret);
    const version = this.keyring.activeVersion;
    const key = this.keyring.keys.get(version);
    if (!key) {
      throw new GatewayError('GATEWAY_VAULT_UNAVAILABLE', 'The active encryption key is missing.');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(VAULT_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const timestamp = this.now().toISOString();
    const record: EncryptedCredentialRecord = {
      ref: this.newRef(),
      ownerRef,
      keyVersion: version,
      algorithm: VAULT_ALGORITHM,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.put(record);
    return { ref: record.ref, keyVersion: version };
  }

  /**
   * Decrypts a credential for an authorized request. Ownership is verified
   * here, so a caller cannot decrypt another owner's credential even if it
   * guesses a reference.
   */
  async read(ownerRef: string, ref: string): Promise<string> {
    const record = await this.store.get(ref);
    if (!record) {
      throw new GatewayError('GATEWAY_CREDENTIAL_MISSING', 'That credential is not available.');
    }
    if (record.ownerRef !== ownerRef) {
      throw new GatewayError('GATEWAY_CREDENTIAL_MISSING', 'That credential is not available.');
    }
    const key = this.keyring.keys.get(record.keyVersion);
    if (!key) {
      throw new GatewayError(
        'GATEWAY_VAULT_DECRYPT_FAILED',
        'That credential was encrypted with a key version this server does not hold.',
      );
    }
    try {
      const decipher = createDecipheriv(VAULT_ALGORITHM, key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return plaintext;
    } catch {
      throw new GatewayError(
        'GATEWAY_VAULT_DECRYPT_FAILED',
        'That credential could not be decrypted; reconnect the provider.',
      );
    }
  }

  /** Replaces the secret in place, keeping the same reference. */
  async replace(ownerRef: string, ref: string, secret: string): Promise<void> {
    assertUsableSecret(secret);
    const existing = await this.store.get(ref);
    if (!existing || existing.ownerRef !== ownerRef) {
      throw new GatewayError('GATEWAY_CREDENTIAL_MISSING', 'That credential is not available.');
    }
    const version = this.keyring.activeVersion;
    const key = this.keyring.keys.get(version);
    if (!key)
      throw new GatewayError('GATEWAY_VAULT_UNAVAILABLE', 'The active encryption key is missing.');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(VAULT_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    await this.store.put({
      ref,
      ownerRef,
      keyVersion: version,
      algorithm: VAULT_ALGORITHM,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString(),
    });
  }

  async delete(ownerRef: string, ref: string): Promise<void> {
    const existing = await this.store.get(ref);
    if (!existing || existing.ownerRef !== ownerRef) return;
    await this.store.delete(ref);
  }
}

const MAX_SECRET_LENGTH = 512;

function assertUsableSecret(secret: string): void {
  if (typeof secret !== 'string') {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'An API key is required.');
  }
  const trimmed = secret.trim();
  if (trimmed.length < 8) {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'That API key is too short to be valid.');
  }
  if (trimmed.length > MAX_SECRET_LENGTH) {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'That API key is too long.');
  }
  if (/[\s]/.test(trimmed)) {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'API keys cannot contain whitespace.');
  }
  if (/[\r\n]/.test(secret)) {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'API keys cannot contain line breaks.');
  }
}

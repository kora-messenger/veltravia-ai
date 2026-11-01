import {
  AIProviderGateway,
  CredentialVault,
  FetchProviderTransport,
  InMemoryConnectionStore,
  InMemoryPreferenceStore,
  InMemoryUsageStore,
  InMemoryVaultRecordStore,
  loadVaultKeyring,
  type VaultKeyring,
} from '@veltravia/ai-gateway';

/**
 * The API process's provider gateway (Step 26).
 *
 * Development stores are in-memory, like every other service in this build:
 * connections, preferences and usage vanish on restart, and so do the encrypted
 * credentials. The ENCRYPTION itself is real (AES-256-GCM with a versioned key
 * from the environment), so the failure mode to avoid - plaintext at rest - is
 * impossible even here.
 *
 * When no encryption key is configured the gateway is NOT constructed and the
 * service reports `ready: false` with the reason. Credential endpoints then
 * refuse with an explicit configuration error instead of silently writing
 * something unencrypted.
 */

export interface GatewayService {
  /** Undefined when encryption is not configured (fail closed). */
  readonly gateway: AIProviderGateway | null;
  readonly ready: boolean;
  /** Human-readable reason when not ready. Safe to show in the UI. */
  readonly blockedReason: string | null;
  /** Key versions the server holds, for the security panel. */
  readonly keyVersions: readonly number[];
}

export interface GatewayServiceOptions {
  readonly now?: () => Date;
  readonly keyring?: VaultKeyring | null;
  readonly transport?: ConstructorParameters<typeof AIProviderGateway>[0]['transport'];
  readonly timeoutMs?: number;
  /** Shortest wait before retrying a rate-limited call (production: 5s). */
  readonly rateLimitFloorMs?: number;
}

export const ENCRYPTION_SETUP_HINT =
  'Set VELTRAVIA_CREDENTIAL_KEY (or VELTRAVIA_CREDENTIAL_KEYS) to a 32-byte base64 key before connecting a provider.';

export function createGatewayService(options: GatewayServiceOptions = {}): GatewayService {
  let keyring: VaultKeyring | null;
  try {
    keyring = options.keyring === undefined ? loadVaultKeyring() : options.keyring;
  } catch (error) {
    return {
      gateway: null,
      ready: false,
      blockedReason: `${error instanceof Error ? error.message : 'Invalid encryption configuration.'} ${ENCRYPTION_SETUP_HINT}`,
      keyVersions: [],
    };
  }
  if (!keyring || keyring.keys.size === 0) {
    return {
      gateway: null,
      ready: false,
      blockedReason: `Credential encryption is not configured, so no API key can be stored safely. ${ENCRYPTION_SETUP_HINT}`,
      keyVersions: [],
    };
  }

  const now = options.now ?? (() => new Date());
  const vault = new CredentialVault({
    keyring,
    store: new InMemoryVaultRecordStore(),
    now,
  });
  const gateway = new AIProviderGateway({
    vault,
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage: new InMemoryUsageStore(),
    transport: options.transport ?? new FetchProviderTransport(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.rateLimitFloorMs !== undefined
      ? { rateLimitFloorMs: options.rateLimitFloorMs }
      : {}),
    now,
  });
  return {
    gateway,
    ready: true,
    blockedReason: null,
    keyVersions: [...keyring.keys.keys()].sort((a, b) => a - b),
  };
}

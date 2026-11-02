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

import {
  seedGroqPool,
  seedMistralPool,
  seedOpenAIPool,
  seedOpenRouterPool,
  type PoolSeedResult,
} from './provider-pool-bootstrap.js';

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
  /**
   * Ensures this owner's OpenRouter pool exists, seeded from the environment.
   * Memoized per owner and safe to call on any request; resolves to an empty
   * result when seeding is disabled or no key is configured.
   */
  readonly ensurePool: (ownerRef: string) => Promise<PoolSeedResult>;
}

export interface GatewayServiceOptions {
  readonly now?: () => Date;
  readonly keyring?: VaultKeyring | null;
  readonly transport?: ConstructorParameters<typeof AIProviderGateway>[0]['transport'];
  readonly timeoutMs?: number;
  /** Shortest wait before retrying a rate-limited call (production: 5s). */
  readonly rateLimitFloorMs?: number;
  /**
   * Seed the owner's OpenRouter pool from OPENROUTER_API_KEY* at startup.
   * Defaults to on for the real network transport only, so a fixture transport
   * in tests never reaches OpenRouter.
   */
  readonly bootstrapOpenRouter?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Owner the startup seed runs for. */
  readonly bootstrapOwnerRef?: string;
}

const NOTHING: PoolSeedResult = {
  connectionId: null,
  keysAdded: 0,
  keysAlreadyPresent: 0,
  keysSkipped: 0,
  defaultModelId: null,
  problems: [],
};

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
      ensurePool: async () => NOTHING,
    };
  }
  if (!keyring || keyring.keys.size === 0) {
    return {
      gateway: null,
      ready: false,
      blockedReason: `Credential encryption is not configured, so no API key can be stored safely. ${ENCRYPTION_SETUP_HINT}`,
      keyVersions: [],
      ensurePool: async () => NOTHING,
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
  const env = options.env ?? process.env;
  const bootstrapEnabled = options.bootstrapOpenRouter ?? options.transport === undefined;
  const seeded = new Map<string, Promise<PoolSeedResult>>();
  const ensurePool = (ownerRef: string): Promise<PoolSeedResult> => {
    if (!bootstrapEnabled) return Promise.resolve(NOTHING);
    const existing = seeded.get(ownerRef);
    if (existing) return existing;
    // One seed per owner per process. A failure is reported, never retried in a
    // loop: the caller still has the API surface to connect a key by hand.
    // OpenRouter first, then OpenAI, which is the owner's default: seeding order
    // is what decides which connection ends up owning the default.
    const attempt = (async () => {
      await seedOpenRouterPool(gateway, ownerRef, { env }).catch(() => NOTHING);
      const openai = await seedOpenAIPool(gateway, ownerRef, { env }).catch(() => NOTHING);
      // Groq and Mistral are seeded after the default so they never steal it.
      await seedGroqPool(gateway, ownerRef, { env }).catch(() => NOTHING);
      await seedMistralPool(gateway, ownerRef, { env }).catch(() => NOTHING);
      return openai;
    })();
    seeded.set(ownerRef, attempt);
    return attempt;
  };

  if (bootstrapEnabled) {
    // Warm the default owner's pool at startup so the first coding run does not
    // pay for it, and so a restart restores capacity without a settings visit.
    const startupOwner =
      options.bootstrapOwnerRef ?? env.VELTRAVIA_DEFAULT_OWNER_REF ?? 'veltravia-dev-user';
    void ensurePool(startupOwner);
  }

  return {
    gateway,
    ready: true,
    blockedReason: null,
    keyVersions: [...keyring.keys.keys()].sort((a, b) => a - b),
    ensurePool,
  };
}

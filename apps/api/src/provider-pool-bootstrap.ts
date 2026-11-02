import { credentialHint, type AIProviderGateway } from '@veltravia/ai-gateway';

/**
 * Seeds the owner's OpenRouter pool from the environment (Step 36).
 *
 * The point is not convenience, it is latency: several OpenRouter keys in one
 * connection means a rate-limited key is replaced by the next one on the same
 * request, instead of the caller waiting out a provider cooldown. Keys that are
 * duplicated, too short to be a key, or rejected by OpenRouter are reported and
 * left out rather than stored as pretend capacity.
 *
 * This is a development bootstrap. It copies the same environment keys into
 * whichever owner asks, which is fine for a single-developer build and wrong for
 * a multi-tenant one; production would have each owner connect their own key
 * through the settings surface.
 */

/** Names accepted: OPENROUTER_API_KEY, OPENROUTER_API_KEY_2, ... */
/**
 * The primary key only. Ijezie asked to run one key and hand over a fresh one
 * when it is spent, so the numbered OPENROUTER_API_KEY_2.. variants are ignored
 * instead of being quietly pooled behind his back.
 */
export const OPENROUTER_ENV_PATTERN = /^OPENROUTER_API_KEY$/;

/**
 * OpenAI keys: OPENAI_API_KEY and, because a secret saved by the platform gets a
 * suffix, OPENAI_API_KEY_2 .. too.
 */
export const OPENAI_ENV_PATTERN = /^OPENAI_API_KEY(?:_\d+)?$/;

/**
 * Default OpenAI model: direct (no hidden reasoning budget), fast and cheap
 * enough to answer a coding decision or an analysis inside a small window.
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export const OPENAI_MODEL_SHORTLIST = ['gpt-4o-mini', 'gpt-4o', 'gpt-5-mini'] as const;

/** Groq keys: one key today, unnumbered or suffixed. */
export const GROQ_ENV_PATTERN = /^GROQ_API_KEY(?:_\d+)?$/;

/** Mistral keys: one key today, unnumbered or suffixed. */
export const MISTRAL_ENV_PATTERN = /^MISTRAL_API_KEY(?:_\d+)?$/;

/**
 * Mistral models that actually serve on this subscription.
 *
 * Probed 2026-11-02: `mistral-large-latest` answers 403 "not available in your
 * subscription" and `mistral-small-latest` answers 429 on every call, while
 * these two answer normally. Naming them keeps the default selectable instead of
 * hoping the vendor list is all reachable.
 */
export const MISTRAL_DEFAULT_MODEL = 'ministral-8b-latest';
export const MISTRAL_MODEL_SHORTLIST = ['ministral-8b-latest', 'open-mistral-nemo'] as const;

/** Groq's fastest reliable ids: a direct model and a large reasoning one. */
export const GROQ_DEFAULT_MODEL = 'qwen/qwen3.8-27b';
export const GROQ_MODEL_SHORTLIST = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'] as const;

/**
 * Default model. A reasoning model (gpt-5-mini) spends its whole output budget
 * on reasoning before writing any content, so on a small balance it returns an
 * empty completion; a direct model answers a JSON decision inside 600 tokens.
 */
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * Models offered on the connection, heaviest last. gpt-5 is the escalation when
 * a plan needs more reasoning; gemini-2.5-flash is kept because it answered in
 * under half a second and is the fastest of the three.
 */
export const OPENROUTER_MODEL_SHORTLIST = [
  OPENROUTER_DEFAULT_MODEL,
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash',
  'openai/gpt-5',
] as const;

/** Shortest string that could plausibly be an OpenRouter key (prefix + 64 chars). */
const MINIMUM_KEY_LENGTH = 40;

export interface PoolSeedResult {
  /** Null when nothing could be seeded, e.g. no keys in the environment. */
  readonly connectionId: string | null;
  readonly keysAdded: number;
  readonly keysAlreadyPresent: number;
  readonly keysSkipped: number;
  readonly defaultModelId: string | null;
  /** Plain sentences about keys that were not used. Never contains a key. */
  readonly problems: readonly string[];
}

const NOTHING_SEEDED: PoolSeedResult = {
  connectionId: null,
  keysAdded: 0,
  keysAlreadyPresent: 0,
  keysSkipped: 0,
  defaultModelId: null,
  problems: [],
};

/**
 * Reads the OpenRouter keys from a process environment, in a stable order, with
 * duplicates removed. A key that is obviously not a key is skipped rather than
 * sent to the provider to be rejected.
 */
export function readProviderKeys(
  env: NodeJS.ProcessEnv,
  pattern: RegExp,
  baseName: string,
): {
  readonly keys: readonly string[];
  readonly skipped: number;
} {
  const names = Object.keys(env)
    .filter((name) => pattern.test(name))
    .sort((a, b) => {
      // The unnumbered name first, then _2, _3, ... numerically.
      const rank = (name: string) => (name === baseName ? 1 : Number(name.split('_').pop()));
      return rank(a) - rank(b);
    });
  const seen = new Set<string>();
  const keys: string[] = [];
  let skipped = 0;
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (value.length < MINIMUM_KEY_LENGTH) {
      skipped += 1;
      continue;
    }
    if (seen.has(value)) {
      skipped += 1; // the same key saved twice is not extra quota
      continue;
    }
    seen.add(value);
    keys.push(value);
  }
  return { keys, skipped };
}

/** OpenRouter keys from the environment, one at a time. */
export function readOpenRouterKeys(env: NodeJS.ProcessEnv): {
  readonly keys: readonly string[];
  readonly skipped: number;
} {
  return readProviderKeys(env, OPENROUTER_ENV_PATTERN, 'OPENROUTER_API_KEY');
}

function codeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export interface SeedOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Provider id to seed. Defaults to OpenRouter. */
  readonly providerId?: string;
  readonly displayName?: string;
  readonly defaultModelId?: string;
  readonly models?: readonly string[];
  readonly envNames?: RegExp;
  /**
   * Explicit keys, used when the caller already holds them (tests, or a future
   * settings screen). The environment path supplies exactly one key.
   */
  readonly keys?: readonly string[];
  /** Force this connection to become the owner's default. */
  readonly makeDefault?: boolean;
  /** Provider name used in plain-language problems. */
  readonly providerName?: string;
}

/**
 * Ensures `ownerRef` has a connection holding every usable environment key, and
 * that it is the default when no default is set yet. Safe to call repeatedly:
 * keys already in the pool are counted, not duplicated.
 */
export async function seedProviderPool(
  gateway: AIProviderGateway,
  ownerRef: string,
  options: SeedOptions = {},
): Promise<PoolSeedResult> {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? 'openrouter';
  const providerName = options.providerName ?? 'OpenRouter';
  const defaultModelId = options.defaultModelId ?? OPENROUTER_DEFAULT_MODEL;
  const models: readonly string[] = options.models ?? OPENROUTER_MODEL_SHORTLIST;
  const explicit = options.keys?.filter((key) => typeof key === 'string' && key.trim().length > 0);
  const { keys, skipped } =
    explicit !== undefined && explicit.length > 0
      ? { keys: explicit.map((key) => key.trim()), skipped: 0 }
      : readProviderKeys(
          env,
          options.envNames ??
            (providerId === 'openai' ? OPENAI_ENV_PATTERN : OPENROUTER_ENV_PATTERN),
          providerId === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY',
        );
  if (keys.length === 0) {
    // A value that is present but unusable must be reported, not silently ignored.
    return {
      ...NOTHING_SEEDED,
      keysSkipped: skipped,
      problems:
        skipped > 0
          ? [
              `${skipped} saved OpenRouter value${skipped === 1 ? ' was' : 's were'} not a usable key and ${skipped === 1 ? 'was' : 'were'} left out.`,
            ]
          : [],
    };
  }

  const problems: string[] = [];
  if (skipped > 0) {
    problems.push(
      `${skipped} saved OpenRouter value${skipped === 1 ? ' was' : 's were'} not a usable key and ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }

  const existing = (await gateway.listConnections({ ownerRef })).find(
    (entry) => entry.connection.providerId === providerId,
  );

  let connectionId: string;
  let keysAdded = 0;
  let consumed = 0;
  // A connection the owner added in Settings is THEIR key: never inject the
  // environment key into it. Only a pool that already holds this environment key
  // is topped up, which is how a restart restores the same pool.
  const seededAlready =
    existing !== undefined &&
    keys.some((key) =>
      existing.connection.keys.some((stored) => stored.hint === credentialHint(key)),
    );
  if (existing && !seededAlready && options.makeDefault !== true) {
    return {
      connectionId: existing.connection.id,
      keysAdded,
      keysSkipped: skipped,
      keysAlreadyPresent: 0,
      problems: [
        ...problems,
        'A connection you added yourself is left untouched; the environment key was not added to it.',
      ],
      defaultModelId: null,
    };
  }
  if (existing) {
    connectionId = existing.connection.id;
  } else {
    // The connection is created from the first key that actually works, not
    // blindly from keys[0]: a key that is rate limited or rejected at this
    // moment must not stop the other keys from forming a pool.
    let created: { id: string } | null = null;
    for (const apiKey of keys) {
      consumed += 1;
      const attempt = await gateway
        .createConnection(
          { ownerRef },
          { providerId, apiKey, displayName: options.displayName ?? providerName },
        )
        .catch((error: unknown) => {
          const code = codeOf(error);
          problems.push(
            code === 'GATEWAY_AUTH_FAILED' || code === 'GATEWAY_CREDENTIAL_INVALID'
              ? 'the provider rejected one saved key while setting the pool up.'
              : 'One saved key could not be stored while setting the pool up.',
          );
          return null;
        });
      if (attempt) {
        created = { id: attempt.id };
        keysAdded += 1;
        break;
      }
    }
    if (!created) {
      return { ...NOTHING_SEEDED, keysSkipped: skipped, problems };
    }
    connectionId = created.id;
  }

  let alreadyPresent = 0;
  for (const apiKey of keys.slice(consumed)) {
    const added = await gateway
      .addKey({ ownerRef }, connectionId, { apiKey })
      .catch((error: unknown) => {
        const code = codeOf(error);
        if (code === 'GATEWAY_KEY_DUPLICATE' || code === 'GATEWAY_CONNECTION_DUPLICATE') {
          alreadyPresent += 1;
          return null;
        }
        problems.push(
          code === 'GATEWAY_AUTH_FAILED' || code === 'GATEWAY_CREDENTIAL_INVALID'
            ? 'the provider rejected one saved key; it was not added to the pool.'
            : 'One saved key could not be added to the pool.',
        );
        return null;
      });
    if (added) keysAdded += 1;
  }

  // Offer the shortlist on the connection itself. Discovery returns hundreds of
  // OpenRouter ids; naming the three this build actually uses keeps the default
  // model selectable instead of hoping it appears in the vendor list.
  const discovered = (await gateway.listConnections({ ownerRef })).find(
    (entry) => entry.connection.id === connectionId,
  );
  const discoveredIds = (discovered?.models ?? []).map((model) => model.modelId);
  const offered = withShortlist(discoveredIds, models);
  if (offered.length !== discoveredIds.length) {
    await gateway
      .updateConnection({ ownerRef }, connectionId, { modelIds: offered })
      .catch(() => undefined);
  }
  const available = offered;
  const preferredModel: string | null =
    available.find((modelId) => modelId === defaultModelId) ??
    (available.length === 0 ? defaultModelId : undefined) ??
    available[0] ??
    null;

  const preferences = await gateway.getPreferences({ ownerRef });
  // Own the default only when nothing else does. Creating a connection already
  // makes it the default pointing at a discovered model, so "no default yet" is
  // not the test; "the default is not somebody else's connection" is.
  const ownsDefault =
    options.makeDefault === true ||
    preferences.defaultConnectionId === null ||
    preferences.defaultConnectionId === undefined ||
    preferences.defaultConnectionId === connectionId;
  if (ownsDefault && preferredModel && preferences.defaultModelId !== preferredModel) {
    await gateway
      .updateConnection({ ownerRef }, connectionId, { defaultModelId: preferredModel })
      .catch(() => undefined);
    await gateway
      .setPreferences(
        { ownerRef },
        { defaultConnectionId: connectionId, defaultModelId: preferredModel },
      )
      .catch(() => undefined);
  }

  return {
    connectionId,
    keysAdded,
    keysAlreadyPresent: alreadyPresent,
    keysSkipped: skipped,
    defaultModelId: ownsDefault ? preferredModel : (preferences.defaultModelId ?? preferredModel),
    problems,
  };
}

/** The OpenRouter pool: one environment key, replaced by hand when it is spent. */
export function seedOpenRouterPool(
  gateway: AIProviderGateway,
  ownerRef: string,
  options: SeedOptions = {},
): Promise<PoolSeedResult> {
  return seedProviderPool(gateway, ownerRef, {
    ...options,
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    defaultModelId: options.defaultModelId ?? OPENROUTER_DEFAULT_MODEL,
    models: options.models ?? OPENROUTER_MODEL_SHORTLIST,
  });
}

/**
 * The OpenAI connection: a second real provider beside OpenRouter, and the
 * owner's default. A platform-saved secret arrives as OPENAI_API_KEY_2, so the
 * numbered names are accepted here.
 */
export function seedOpenAIPool(
  gateway: AIProviderGateway,
  ownerRef: string,
  options: SeedOptions = {},
): Promise<PoolSeedResult> {
  return seedProviderPool(gateway, ownerRef, {
    ...options,
    providerId: 'openai',
    providerName: 'OpenAI',
    displayName: 'OpenAI',
    defaultModelId: options.defaultModelId ?? OPENAI_DEFAULT_MODEL,
    models: options.models ?? OPENAI_MODEL_SHORTLIST,
    makeDefault: true,
  });
}

/**
 * The Groq connection: a third real provider, and the fast one. It is not the
 * default (OpenAI is), but a default that cannot serve is worse than a slow one,
 * so the execution service falls back to whichever provider still has capacity.
 */
export function seedGroqPool(
  gateway: AIProviderGateway,
  ownerRef: string,
  options: SeedOptions = {},
): Promise<PoolSeedResult> {
  return seedProviderPool(gateway, ownerRef, {
    ...options,
    providerId: 'groq',
    providerName: 'Groq',
    displayName: 'Groq',
    envNames: GROQ_ENV_PATTERN,
    defaultModelId: options.defaultModelId ?? GROQ_DEFAULT_MODEL,
    models: options.models ?? GROQ_MODEL_SHORTLIST,
    makeDefault: false,
  });
}

/** The Mistral connection: a fourth real provider, available to failover. */
export function seedMistralPool(
  gateway: AIProviderGateway,
  ownerRef: string,
  options: SeedOptions = {},
): Promise<PoolSeedResult> {
  return seedProviderPool(gateway, ownerRef, {
    ...options,
    providerId: 'mistral',
    providerName: 'Mistral',
    displayName: 'Mistral',
    envNames: MISTRAL_ENV_PATTERN,
    defaultModelId: options.defaultModelId ?? MISTRAL_DEFAULT_MODEL,
    models: options.models ?? MISTRAL_MODEL_SHORTLIST,
    makeDefault: false,
  });
}

/** Rewrites a connection's model shortlist so the default is always offered. */
export function withShortlist(models: readonly string[], shortlist: readonly string[]): string[] {
  const merged = new Set<string>();
  for (const model of shortlist) merged.add(model);
  for (const model of models) merged.add(model);
  return [...merged];
}

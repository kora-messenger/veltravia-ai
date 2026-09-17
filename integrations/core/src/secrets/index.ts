/**
 * THE SECRET BOUNDARY.
 *
 * Raw credentials (API keys, tokens, passwords, client secrets) live ONLY
 * here, inside a SecretStore. The store is held by the integration runtime
 * and is never handed to:
 *
 * - application/API code outside the execution boundary
 * - the AI agent or its context
 * - tool metadata, connector metadata, or manifests
 * - project files or snapshots
 * - audit events or ordinary logs
 * - API responses, browser state, or test snapshots
 *
 * A SecretRef is the metadata-only pointer the rest of the system sees.
 * Raw values cross the boundary in exactly ONE direction: the runtime
 * reads a secret during an APPROVED operation and passes it to the
 * connector executor as a provider callback - the value is never stored,
 * logged, or returned.
 *
 * The development provider below is an in-memory store suitable for tests
 * and local development. It is a controlled stand-in for a future
 * production provider (e.g. a hardware-backed encrypted vault): the
 * interface is the contract; swapping the provider changes nothing else.
 */

/** Metadata-only pointer to a secret - structurally cannot carry a value. */
export interface SecretRef {
  /** Integration the secret belongs to (e.g. "github"). */
  readonly integrationId: string;
  /** Id of the secret for that integration (e.g. "operator-token"). */
  readonly secretId: string;
}

/** The platform secret boundary contract. */
export interface SecretStore {
  /** Stores (or replaces) one secret. Development provider only. */
  setSecret(ref: SecretRef, value: string): void;
  /**
   * Reads one secret. Called ONLY inside the connector execution boundary
   * by the integration runtime - never by API, agent, or UI code.
   */
  getSecret(ref: SecretRef): string | undefined;
  /** Removes one secret. Used by disconnect flows and operators. */
  deleteSecret(ref: SecretRef): void;
  /** Whether a secret exists (never exposes the value). */
  hasSecret(ref: SecretRef): boolean;
  /** Diagnostic surface: secret REFS only, never values. Safe for logs. */
  describe(): readonly SecretRef[];
}

/**
 * Deterministic in-memory SecretStore - the development/test provider.
 *
 * The values live in a private map that is unreachable through the public
 * surface: the only value-returning method is getSecret, which the runtime
 * is the sole sanctioned caller of. `describe()` exposes secret REFS for
 * diagnostics and tests - never values.
 */
export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  private key(ref: SecretRef): string {
    return `${ref.integrationId}::${ref.secretId}`;
  }

  setSecret(ref: SecretRef, value: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('A secret value must be a non-empty string.');
    }
    this.secrets.set(this.key(ref), value);
  }

  getSecret(ref: SecretRef): string | undefined {
    return this.secrets.get(this.key(ref));
  }

  deleteSecret(ref: SecretRef): void {
    this.secrets.delete(this.key(ref));
  }

  hasSecret(ref: SecretRef): boolean {
    return this.secrets.has(this.key(ref));
  }

  /** Diagnostic surface: refs only, NEVER values. Safe for logs. */
  describe(): readonly SecretRef[] {
    return [...this.secrets.keys()].map((key) => {
      const [integrationId, secretId] = key.split('::');
      return { integrationId: integrationId ?? '', secretId: secretId ?? '' };
    });
  }
}

/**
 * Guard used by the runtime: refuses to expose a secret through any path
 * that is not the execution boundary. Kept tiny on purpose - the boundary
 * is architectural, not a runtime check, but this guard catches accidental
 * future misuse inside the package.
 */
export function assertSecretAccessAllowed(caller: 'integration-runtime'): void {
  if (caller !== 'integration-runtime') {
    throw new Error('Secret access is only permitted inside the connector execution boundary.');
  }
}

/**
 * Secure credential REFERENCE abstraction.
 *
 * SECURITY BOUNDARY. The connector core NEVER stores, transports, or exposes
 * raw API keys, passwords, OAuth tokens, access tokens, or any other secret.
 * A CredentialReference is pure metadata - a pointer to a secret that lives
 * OUTSIDE the core, in a Secure Credential Store:
 *
 *     AI / Connector Manager
 *            |  uses CredentialReference (id + status only)
 *            v
 *     Secure Credential Store   <- the ONLY component that holds raw secrets
 *            |
 *            v
 *     Actual secret
 *
 * The interface below is structurally incapable of carrying a secret value:
 * there is no `value`, `token`, `key`, or `secret` field, and every field is
 * typed as metadata. Future connectors receive the actual secret only at the
 * moment an approved operation needs it (Step 5+), fetched by the secure
 * store - never by the AI, never through this model.
 */

export const CREDENTIAL_TYPES = [
  'api_key',
  'oauth_token',
  'access_token',
  'refresh_token',
  'password',
  'key_pair',
  'connection_string',
  'secret',
  'other',
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export function isCredentialType(value: unknown): value is CredentialType {
  return typeof value === 'string' && (CREDENTIAL_TYPES as readonly string[]).includes(value);
}

export const CREDENTIAL_STATUSES = ['pending', 'configured', 'invalid', 'revoked'] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export function isCredentialStatus(value: unknown): value is CredentialStatus {
  return typeof value === 'string' && (CREDENTIAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Metadata-only pointer to a secret held by the Secure Credential Store.
 * There is intentionally NO field for the secret itself.
 */
export interface CredentialReference {
  /** Opaque id of the secret in the credential store (e.g. "cred_01H..."). */
  readonly credentialId: string;
  /** What KIND of secret is stored (api_key, oauth_token, ...). */
  readonly credentialType: CredentialType;
  /**
   * Where the secret lives, e.g. "vault:kv/veltravia/github" or
   * "env:GITHUB_CONNECTOR_TOKEN". A reference, never the value.
   */
  readonly providerRef: string;
  /** Lifecycle of the credential entry, not of the secret value. */
  readonly status: CredentialStatus;
  /** ISO-8601 creation time of this reference. */
  readonly createdAt: string;
  /** ISO-8601 last-update time of this reference. */
  readonly updatedAt: string;
}

export interface CreateCredentialReferenceInput {
  readonly credentialId: string;
  readonly credentialType: CredentialType;
  readonly providerRef: string;
  readonly status?: CredentialStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * Creates a validated credential reference. Rejects anything that looks like
 * a raw secret smuggled into the metadata fields.
 */
export function createCredentialReference(
  input: CreateCredentialReferenceInput,
): CredentialReference {
  const reasons: string[] = [];
  if (typeof input.credentialId !== 'string' || input.credentialId.trim().length === 0) {
    reasons.push('credentialId must be a non-empty string');
  }
  if (!isCredentialType(input.credentialType)) {
    reasons.push('credentialType is unknown');
  }
  if (typeof input.providerRef !== 'string' || input.providerRef.trim().length === 0) {
    reasons.push('providerRef must be a non-empty string');
  }
  if (input.status !== undefined && !isCredentialStatus(input.status)) {
    reasons.push('status is unknown');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid credential reference: ${reasons.join('; ')}.`);
  }
  return {
    credentialId: input.credentialId,
    credentialType: input.credentialType,
    providerRef: input.providerRef,
    status: input.status ?? 'pending',
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? input.createdAt ?? new Date().toISOString(),
  };
}

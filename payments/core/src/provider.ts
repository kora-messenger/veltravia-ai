/**
 * The provider seam.
 *
 * A payment provider is reached through one interface and one transport. The
 * transport is injected, which is what makes every adapter testable without a
 * network and what keeps a live key out of a test: the suite passes a transport
 * that answers from a fixture, and nothing in this package can reach the
 * internet by itself.
 *
 * The interface is deliberately narrower than any provider's API. It covers the
 * five things this build does - initialize a hosted checkout, verify a
 * transaction, charge a stored authorization, refund, and read a webhook - and
 * every adapter declares which of those it actually supports in
 * `ProviderCapabilities`. A caller that needs a capability the provider does not
 * have is told so instead of being handed a silent no-op.
 */

import type {
  CheckoutSession,
  NormalizedEvent,
  PaymentMode,
  PaymentProviderId,
  ProviderCapabilities,
  RefundResult,
  VerifiedTransaction,
} from './types.js';

export interface ProviderHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface ProviderHttpResponse {
  readonly status: number;
  /** Parsed JSON when the body is JSON; otherwise null. */
  readonly body: unknown;
  /** The body exactly as received, for signature checks and diagnostics. */
  readonly raw: string;
}

/** Injected. The API supplies one backed by `fetch`; tests supply a fixture. */
export type PaymentTransport = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;

/** The secrets an adapter needs. Read from the environment by the caller. */
export interface ProviderCredentials {
  readonly mode: PaymentMode;
  /** Never logged, never returned by a route, never written to a row. */
  readonly secretKey: string;
  /** The webhook signing secret (Paystack and Monnify secret key, Flutterwave hash). */
  readonly webhookSecret: string;
  /** Optional override, so a sandbox host can be pointed at without a code change. */
  readonly baseUrl?: string;
}

export interface InitializePaymentInput {
  /** This server's reference. The provider stores it and returns it on verify. */
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly email: string;
  readonly customerName: string;
  readonly description: string;
  readonly callbackUrl: string;
  /** Extra data the provider echoes back. Never used as authority. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ChargeAuthorizationInput {
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly email: string;
  readonly authorizationCode: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface RefundInput {
  readonly providerReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
}

export interface WebhookInput {
  /** The exact bytes received. Re-serializing first would break the HMAC. */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface WebhookVerdict {
  readonly valid: boolean;
  /** Why it was refused, in words an operator can act on. Never the secret. */
  readonly reason: string | null;
}

export interface ProviderAdapter {
  readonly id: PaymentProviderId;
  readonly mode: PaymentMode;
  readonly capabilities: ProviderCapabilities;
  initialize(input: InitializePaymentInput): Promise<CheckoutSession>;
  verify(reference: string): Promise<VerifiedTransaction>;
  /** Refuses with `CAPABILITY_UNSUPPORTED` when the provider cannot refund. */
  refund(input: RefundInput): Promise<RefundResult>;
  /** Charges a stored token. Refuses when `capabilities.recurring` is false. */
  chargeAuthorization(input: ChargeAuthorizationInput): Promise<VerifiedTransaction>;
  verifyWebhook(input: WebhookInput): WebhookVerdict;
  /** Reads a payload that already passed `verifyWebhook`. */
  parseWebhook(input: { rawBody: string }): NormalizedEvent;
}

/**
 * A provider could not be reached, or answered in a way this build cannot trust.
 * `status` is chosen by the caller's context, not here: the same error is a 502
 * on a checkout and a retryable failure on a webhook.
 */
export class ProviderError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export class CapabilityUnsupportedError extends ProviderError {
  constructor(provider: PaymentProviderId, capability: string) {
    super(
      'CAPABILITY_UNSUPPORTED',
      `${provider} does not support ${capability} in this build, so nothing was charged.`,
      { details: { provider, capability } },
    );
    this.name = 'CapabilityUnsupportedError';
  }
}

/** Reads a nested value without trusting any level of the shape. */
export function pick(source: unknown, ...path: readonly string[]): unknown {
  let current: unknown = source;
  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * The three shipped adapters.
 *
 * Each one is a translation layer, not a policy: it converts this build's minor
 * units into whatever unit the provider expects, turns the provider's own status
 * words into the four this build understands, and proves a webhook's signature
 * over the exact bytes received.
 *
 * What is deliberately *not* uniform, and is declared rather than papered over:
 *
 *  - **Amount unit.** Paystack takes minor units; Flutterwave and Monnify take a
 *    decimal in major units. Converting at a call site would be a rounding bug
 *    waiting to happen, so it happens once, in each adapter.
 *  - **Recurring.** Paystack and Flutterwave can charge a stored authorization;
 *    Monnify's recurring debit needs a direct-debit mandate this build does not
 *    collect, so it declares `recurring: false` and renewals stay manual.
 *  - **Refund lookup.** Flutterwave and Monnify refund by their own transaction
 *    id, not by our reference, so those adapters resolve the id with a verify
 *    call first. That is an extra round trip and it is the honest way to do it.
 *  - **Webhook proof.** Paystack and Monnify sign the body with HMAC-SHA512; a
 *    Flutterwave webhook carries a pre-shared hash in a header and signs nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  assertMinorAmount,
  fromMajorUnits,
  normalizeCurrency,
  toMajorUnitsString,
} from './money.js';
import {
  CapabilityUnsupportedError,
  ProviderError,
  asRecord,
  asString,
  pick,
  type ChargeAuthorizationInput,
  type InitializePaymentInput,
  type PaymentTransport,
  type ProviderAdapter,
  type ProviderCredentials,
  type RefundInput,
  type WebhookInput,
  type WebhookVerdict,
} from './provider.js';
import type {
  CheckoutSession,
  NormalizedEvent,
  PaymentMode,
  PaymentProviderId,
  ProviderCapabilities,
  RefundResult,
  VerifiedTransaction,
} from './types.js';

const PAYSTACK_BASE = 'https://api.paystack.co';
const FLUTTERWAVE_BASE = 'https://api.flutterwave.com/v3';
const MONNIFY_LIVE_BASE = 'https://api.monnify.com';
const MONNIFY_TEST_BASE = 'https://sandbox.monnify.com';

const PAYSTACK_CAPABILITIES: ProviderCapabilities = {
  recurring: true,
  hostedCheckout: true,
  refunds: true,
  partialRefunds: true,
  webhooks: true,
  currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'],
  amountUnit: 'minor',
  signature: 'hmac-sha512-body',
};

const FLUTTERWAVE_CAPABILITIES: ProviderCapabilities = {
  recurring: true,
  hostedCheckout: true,
  refunds: true,
  partialRefunds: true,
  webhooks: true,
  currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'USD', 'EUR', 'GBP'],
  amountUnit: 'major',
  signature: 'shared-secret-header',
};

const MONNIFY_CAPABILITIES: ProviderCapabilities = {
  recurring: false,
  hostedCheckout: true,
  refunds: true,
  partialRefunds: true,
  webhooks: true,
  currencies: ['NGN', 'GHS', 'USD'],
  amountUnit: 'major',
  signature: 'hmac-sha512-body',
};

export function capabilitiesFor(provider: PaymentProviderId): ProviderCapabilities {
  switch (provider) {
    case 'paystack':
      return PAYSTACK_CAPABILITIES;
    case 'flutterwave':
      return FLUTTERWAVE_CAPABILITIES;
    case 'monnify':
      return MONNIFY_CAPABILITIES;
  }
}

async function call(
  transport: PaymentTransport,
  request: Parameters<PaymentTransport>[0],
): Promise<{ status: number; body: unknown; raw: string }> {
  let response;
  try {
    response = await transport(request);
  } catch (error) {
    throw new ProviderError(
      'PROVIDER_UNREACHABLE',
      'The payment provider could not be reached. Nothing was charged.',
      {
        retryable: true,
        details: { reason: error instanceof Error ? error.message : 'unknown' },
      },
    );
  }
  return response;
}

function requireOk(
  provider: PaymentProviderId,
  response: { status: number; body: unknown },
  what: string,
): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    const message =
      asString(pick(response.body, 'message')) ??
      asString(pick(response.body, 'responseMessage')) ??
      `${provider} refused the ${what} request.`;
    throw new ProviderError('PROVIDER_REFUSED', message, {
      // A 5xx or a 429 is worth retrying; a 4xx is not.
      retryable: response.status >= 500 || response.status === 429,
      details: { provider, status: response.status },
    });
  }
  const body = asRecord(response.body);
  if (body === null) {
    throw new ProviderError('PROVIDER_MALFORMED', `${provider} answered with no JSON body.`, {
      retryable: true,
      details: { provider },
    });
  }
  return body;
}

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, rawBody: string): string {
  return createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
}

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string): string {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  const lower = headers[name.toLowerCase()];
  return typeof lower === 'string' ? lower : '';
}

/** Paystack's `status` word, mapped onto the four this build understands. */
function paystackStatus(status: string | null): VerifiedTransaction['status'] {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'abandoned':
    case 'reversed':
      return 'abandoned';
    default:
      return 'pending';
  }
}

/** Flutterwave states a card expiry as `MM/YY`; read one side of it. */
function expiryPart(value: unknown, offset: number): string | null {
  if (typeof value !== 'string') return null;
  const part = value.replace(/[^0-9]/g, '').slice(offset === 0 ? 0 : 2);
  return part === '' ? null : part;
}

function flutterwaveStatus(status: string | null): VerifiedTransaction['status'] {
  switch (status) {
    case 'successful':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'pending';
  }
}

function monnifyStatus(status: string | null): VerifiedTransaction['status'] {
  switch (status) {
    case 'PAID':
    case 'OVERPAID':
      return 'succeeded';
    case 'FAILED':
    case 'CANCELLED':
    case 'REVERSED':
      return 'failed';
    case 'EXPIRED':
      return 'abandoned';
    default:
      return 'pending';
  }
}

export interface AdapterConfig extends ProviderCredentials {
  readonly provider: PaymentProviderId;
  readonly transport: PaymentTransport;
}

export function createPaystackAdapter(config: AdapterConfig): ProviderAdapter {
  if (config.secretKey === '') {
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Paystack has no secret key configured.');
  }
  const base = config.baseUrl ?? PAYSTACK_BASE;
  const headers = {
    authorization: `Bearer ${config.secretKey}`,
    'content-type': 'application/json',
  } as const;

  return {
    id: 'paystack',
    mode: config.mode,
    capabilities: PAYSTACK_CAPABILITIES,

    async initialize(input: InitializePaymentInput): Promise<CheckoutSession> {
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/transaction/initialize`,
        headers,
        body: {
          email: input.email,
          amount: assertMinorAmount(input.amountMinor, 'amount'),
          currency: normalizeCurrency(input.currency),
          reference: input.reference,
          callback_url: input.callbackUrl,
          metadata: input.metadata,
        },
      });
      const body = requireOk('paystack', response, 'checkout');
      const url = asString(pick(body, 'data', 'authorization_url'));
      if (url === null) {
        throw new ProviderError('PROVIDER_MALFORMED', 'Paystack returned no checkout link.', {
          retryable: true,
        });
      }
      return {
        checkoutUrl: url,
        providerReference: asString(pick(body, 'data', 'reference')),
        mode: config.mode,
      };
    },

    async verify(reference: string): Promise<VerifiedTransaction> {
      const response = await call(config.transport, {
        method: 'GET',
        url: `${base}/transaction/verify/${encodeURIComponent(reference)}`,
        headers,
      });
      const body = requireOk('paystack', response, 'verification');
      const data = asRecord(pick(body, 'data')) ?? {};
      const status = paystackStatus(asString(data.status));
      const currency = normalizeCurrency(asString(data.currency) ?? 'NGN');
      const authorization = asRecord(data.authorization);
      return {
        providerReference: asString(data.reference) ?? reference,
        status,
        amountMinor: assertMinorAmount(Number(data.amount ?? 0), 'verified amount'),
        currency,
        channel: asString(data.channel),
        paidAt: asString(data.paid_at),
        failureReason: status === 'succeeded' ? null : asString(data.gateway_response),
        authorization:
          authorization === null || asString(authorization.authorization_code) === null
            ? null
            : {
                code: asString(authorization.authorization_code) as string,
                reusable: authorization.reusable === true,
                brand: asString(authorization.brand),
                last4: asString(authorization.last4),
                expMonth: asString(authorization.exp_month),
                expYear: asString(authorization.exp_year),
              },
        raw: body,
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/refund`,
        headers,
        body: {
          transaction: input.providerReference,
          amount: assertMinorAmount(input.amountMinor, 'refund'),
          merchant_note: input.reason.slice(0, 200),
        },
      });
      const body = requireOk('paystack', response, 'refund');
      const data = asRecord(pick(body, 'data')) ?? {};
      const statusWord = (asString(data.status) ?? '').toLowerCase();
      return {
        providerReference: asString(data.id) ?? asString(data.reference),
        status:
          statusWord === 'processed' || statusWord === 'pending' || statusWord === 'succeeded'
            ? 'succeeded'
            : statusWord === 'failed'
              ? 'failed'
              : 'pending',
        amountMinor: Number(data.amount ?? input.amountMinor),
        raw: body,
      };
    },

    async chargeAuthorization(input: ChargeAuthorizationInput): Promise<VerifiedTransaction> {
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/transaction/charge_authorization`,
        headers,
        body: {
          authorization_code: input.authorizationCode,
          email: input.email,
          amount: assertMinorAmount(input.amountMinor, 'amount'),
          currency: normalizeCurrency(input.currency),
          reference: input.reference,
          metadata: input.metadata,
        },
      });
      const body = requireOk('paystack', response, 'renewal charge');
      const data = asRecord(pick(body, 'data')) ?? {};
      const status = paystackStatus(asString(data.status));
      return {
        providerReference: asString(data.reference) ?? input.reference,
        status,
        amountMinor: assertMinorAmount(Number(data.amount ?? 0), 'charged amount'),
        currency: normalizeCurrency(asString(data.currency) ?? input.currency),
        channel: asString(data.channel),
        paidAt: asString(data.paid_at),
        failureReason: status === 'succeeded' ? null : asString(data.gateway_response),
        authorization: null,
        raw: body,
      };
    },

    verifyWebhook(input: WebhookInput): WebhookVerdict {
      if (config.webhookSecret === '') {
        return { valid: false, reason: 'No Paystack webhook secret is configured.' };
      }
      const presented = headerValue(input.headers, 'x-paystack-signature');
      if (presented === '') return { valid: false, reason: 'The signature header is missing.' };
      const expected = hmacHex(config.webhookSecret, input.rawBody);
      return safeEqual(presented, expected)
        ? { valid: true, reason: null }
        : { valid: false, reason: 'The signature does not match the body.' };
    },

    parseWebhook(input: { rawBody: string }): NormalizedEvent {
      const parsed = asRecord(JSON.parse(input.rawBody) as unknown) ?? {};
      const data = asRecord(parsed.data) ?? {};
      const status = paystackStatus(asString(data.status));
      const eventType = asString(parsed.event) ?? 'unknown';
      const id = asString(data.id) ?? asString(data.reference) ?? eventType;
      return {
        eventId: `paystack:${eventType}:${id}`,
        eventType,
        reference: asString(data.reference),
        amountMinor: data.amount === undefined ? null : Number(data.amount),
        currency: asString(data.currency),
        status:
          eventType === 'charge.success'
            ? 'succeeded'
            : status === 'succeeded'
              ? 'succeeded'
              : status === 'failed'
                ? 'failed'
                : 'unknown',
        occurredAt: asString(data.paid_at) ?? asString(parsed.created_at),
        raw: parsed,
      };
    },
  };
}

export function createFlutterwaveAdapter(config: AdapterConfig): ProviderAdapter {
  if (config.secretKey === '') {
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Flutterwave has no secret key configured.');
  }
  const base = config.baseUrl ?? FLUTTERWAVE_BASE;
  const headers = {
    authorization: `Bearer ${config.secretKey}`,
    'content-type': 'application/json',
  } as const;

  /** Flutterwave refunds by its numeric id, so a verify resolves it first. */
  const resolveTransactionId = async (reference: string): Promise<string> => {
    const response = await call(config.transport, {
      method: 'GET',
      url: `${base}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      headers,
    });
    const body = requireOk('flutterwave', response, 'verification');
    const id = asString(pick(body, 'data', 'id'));
    if (id === null) {
      throw new ProviderError(
        'PROVIDER_MALFORMED',
        'Flutterwave did not return a transaction id for that reference.',
        { retryable: true },
      );
    }
    return id;
  };

  return {
    id: 'flutterwave',
    mode: config.mode,
    capabilities: FLUTTERWAVE_CAPABILITIES,

    async initialize(input: InitializePaymentInput): Promise<CheckoutSession> {
      const currency = normalizeCurrency(input.currency);
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/payments`,
        headers,
        body: {
          tx_ref: input.reference,
          // Flutterwave wants major units as a decimal string.
          amount: toMajorUnitsString(input.amountMinor, currency),
          currency,
          redirect_url: input.callbackUrl,
          customer: { email: input.email, name: input.customerName },
          customizations: { title: 'Veltravia AI', description: input.description },
          meta: input.metadata,
        },
      });
      const body = requireOk('flutterwave', response, 'checkout');
      const url = asString(pick(body, 'data', 'link'));
      if (url === null) {
        throw new ProviderError('PROVIDER_MALFORMED', 'Flutterwave returned no checkout link.', {
          retryable: true,
        });
      }
      return { checkoutUrl: url, providerReference: input.reference, mode: config.mode };
    },

    async verify(reference: string): Promise<VerifiedTransaction> {
      const response = await call(config.transport, {
        method: 'GET',
        url: `${base}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        headers,
      });
      const body = requireOk('flutterwave', response, 'verification');
      const data = asRecord(pick(body, 'data')) ?? {};
      const currency = normalizeCurrency(asString(data.currency) ?? 'NGN');
      const status = flutterwaveStatus(asString(data.status));
      const card = asRecord(data.card);
      const token = card === null ? null : asString(card.token);
      return {
        providerReference: asString(data.tx_ref) ?? reference,
        status,
        amountMinor: fromMajorUnits(data.amount ?? 0, currency),
        currency,
        channel: asString(data.payment_type),
        paidAt: status === 'succeeded' ? asString(data.created_at) : null,
        failureReason: status === 'succeeded' ? null : asString(data.processor_response),
        authorization:
          token === null
            ? null
            : {
                code: token,
                reusable: true,
                brand: card === null ? null : asString(card.type),
                last4:
                  card !== null && asString(card.card_tokens) !== null
                    ? (asString(card.card_tokens)?.slice(-4) ?? null)
                    : null,
                expMonth: card === null ? null : expiryPart(card.expiry, 0),
                expYear: card === null ? null : expiryPart(card.expiry, 3),
              },
        raw: body,
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const id = await resolveTransactionId(input.providerReference);
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/transactions/${encodeURIComponent(id)}/refund`,
        headers,
        body: {
          amount: toMajorUnitsString(input.amountMinor, normalizeCurrency(input.currency)),
          comments: input.reason.slice(0, 200),
        },
      });
      const body = requireOk('flutterwave', response, 'refund');
      const data = asRecord(pick(body, 'data')) ?? {};
      const statusWord = (asString(data.status) ?? '').toLowerCase();
      return {
        providerReference: asString(data.id) ?? id,
        status: statusWord === 'completed' || statusWord === 'successful' ? 'succeeded' : 'pending',
        amountMinor: input.amountMinor,
        raw: body,
      };
    },

    async chargeAuthorization(input: ChargeAuthorizationInput): Promise<VerifiedTransaction> {
      const currency = normalizeCurrency(input.currency);
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/tokenized-charges`,
        headers,
        body: {
          token: input.authorizationCode,
          amount: toMajorUnitsString(input.amountMinor, currency),
          currency,
          email: input.email,
          tx_ref: input.reference,
          narration: input.description,
          meta: input.metadata,
        },
      });
      const body = requireOk('flutterwave', response, 'renewal charge');
      const data = asRecord(pick(body, 'data')) ?? {};
      const status = flutterwaveStatus(asString(data.status));
      return {
        providerReference: asString(data.tx_ref) ?? input.reference,
        status,
        amountMinor: fromMajorUnits(data.charged_amount ?? data.amount ?? 0, currency),
        currency,
        channel: asString(data.payment_type),
        paidAt: status === 'succeeded' ? asString(data.created_at) : null,
        failureReason: status === 'succeeded' ? null : asString(data.processor_response),
        authorization: null,
        raw: body,
      };
    },

    verifyWebhook(input: WebhookInput): WebhookVerdict {
      if (config.webhookSecret === '') {
        return { valid: false, reason: 'No Flutterwave webhook hash is configured.' };
      }
      const presented = headerValue(input.headers, 'verif-hash');
      if (presented === '') return { valid: false, reason: 'The verif-hash header is missing.' };
      return safeEqual(presented, config.webhookSecret)
        ? { valid: true, reason: null }
        : { valid: false, reason: 'The webhook hash does not match.' };
    },

    parseWebhook(input: { rawBody: string }): NormalizedEvent {
      const parsed = asRecord(JSON.parse(input.rawBody) as unknown) ?? {};
      const data = asRecord(parsed.data) ?? {};
      const eventType = asString(parsed.event) ?? 'unknown';
      const status = flutterwaveStatus(asString(data.status));
      const id = asString(data.id) ?? asString(data.tx_ref) ?? eventType;
      return {
        eventId: `flutterwave:${eventType}:${id}`,
        eventType,
        reference: asString(data.tx_ref),
        amountMinor: null,
        currency: asString(data.currency),
        status:
          eventType === 'charge.completed'
            ? status === 'failed'
              ? 'failed'
              : 'succeeded'
            : status === 'succeeded'
              ? 'succeeded'
              : status === 'failed'
                ? 'failed'
                : 'unknown',
        occurredAt: asString(data.created_at),
        raw: parsed,
      };
    },
  };
}

export function createMonnifyAdapter(config: AdapterConfig): ProviderAdapter {
  if (config.secretKey === '') {
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Monnify has no API key configured.');
  }
  const base = config.baseUrl ?? (config.mode === 'live' ? MONNIFY_LIVE_BASE : MONNIFY_TEST_BASE);

  /*
   * Monnify authenticates with a short-lived bearer token. The token is cached
   * for slightly less than its stated lifetime, because a token that expires
   * between the cache check and the call is a failed payment.
   */
  let token: { value: string; expiresAt: number } | null = null;

  /*
   * Monnify needs two credentials - an API key and a secret key - where the
   * other two providers need one. `secretKey` therefore carries both as
   * `apiKey:secretKey`, which `docs/payments.md` states plainly rather than
   * hiding a second credential field.
   */
  const basicAuth = (): string => {
    const [apiKey = '', secret = ''] = config.secretKey.split(':');
    if (apiKey === '' || secret === '') {
      throw new ProviderError(
        'PROVIDER_NOT_CONFIGURED',
        'Monnify needs MONNIFY_API_KEY:SECRET_KEY in the configured secret.',
      );
    }
    return `Basic ${Buffer.from(`${apiKey}:${secret}`, 'utf8').toString('base64')}`;
  };

  const accessToken = async (): Promise<string> => {
    if (token !== null && Date.now() < token.expiresAt) return token.value;
    const response = await call(config.transport, {
      method: 'POST',
      url: `${base}/api/v1/auth/login`,
      headers: { authorization: basicAuth(), 'content-type': 'application/json' },
    });
    const body = requireOk('monnify', response, 'authentication');
    const value = asString(pick(body, 'responseBody', 'accessToken'));
    if (value === null) {
      throw new ProviderError('PROVIDER_MALFORMED', 'Monnify returned no access token.', {
        retryable: true,
      });
    }
    const lifetimeSeconds = Number(pick(body, 'responseBody', 'expiresIn') ?? 3000);
    token = {
      value,
      expiresAt: Date.now() + Math.max(30, lifetimeSeconds - 60) * 1000,
    };
    return value;
  };

  const authed = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await accessToken()}`,
    'content-type': 'application/json',
  });

  const query = async (reference: string): Promise<Record<string, unknown>> => {
    const response = await call(config.transport, {
      method: 'GET',
      url: `${base}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`,
      headers: await authed(),
    });
    const body = requireOk('monnify', response, 'verification');
    return asRecord(pick(body, 'responseBody')) ?? {};
  };

  return {
    id: 'monnify',
    mode: config.mode,
    capabilities: MONNIFY_CAPABILITIES,

    async initialize(input: InitializePaymentInput): Promise<CheckoutSession> {
      const currency = normalizeCurrency(input.currency);
      const contractCode = input.metadata.contractCode ?? '';
      if (contractCode === '') {
        throw new ProviderError(
          'PROVIDER_NOT_CONFIGURED',
          'Monnify needs a contract code. Set it on the provider configuration.',
        );
      }
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/api/v2/merchant/transactions/init-transaction`,
        headers: await authed(),
        body: {
          amount: Number(toMajorUnitsString(input.amountMinor, currency)),
          customerName: input.customerName,
          customerEmail: input.email,
          paymentReference: input.reference,
          paymentDescription: input.description,
          currencyCode: currency,
          contractCode,
          redirectUrl: input.callbackUrl,
        },
      });
      const body = requireOk('monnify', response, 'checkout');
      const url = asString(pick(body, 'responseBody', 'checkoutUrl'));
      if (url === null) {
        throw new ProviderError('PROVIDER_MALFORMED', 'Monnify returned no checkout link.', {
          retryable: true,
        });
      }
      return {
        checkoutUrl: url,
        providerReference: asString(pick(body, 'responseBody', 'transactionReference')),
        mode: config.mode,
      };
    },

    async verify(reference: string): Promise<VerifiedTransaction> {
      const data = await query(reference);
      const currency = normalizeCurrency(asString(data.currencyCode) ?? 'NGN');
      const status = monnifyStatus(asString(data.paymentStatus));
      return {
        providerReference: asString(data.paymentReference) ?? reference,
        status,
        amountMinor: fromMajorUnits(data.amountPaid ?? data.totalPayable ?? 0, currency),
        currency,
        channel: asString(data.paymentMethod),
        paidAt: asString(data.paidOn),
        failureReason: status === 'succeeded' ? null : asString(data.paymentStatus),
        authorization: null,
        raw: data,
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // Monnify refunds by its own transaction reference, resolved by a query.
      const data = await query(input.providerReference);
      const transactionReference = asString(data.transactionReference);
      if (transactionReference === null) {
        throw new ProviderError(
          'PROVIDER_MALFORMED',
          'Monnify did not return a transaction reference to refund.',
          { retryable: true },
        );
      }
      const currency = normalizeCurrency(input.currency);
      const response = await call(config.transport, {
        method: 'POST',
        url: `${base}/api/v1/merchant/transactions/refund`,
        headers: await authed(),
        body: {
          transactionReference,
          refundAmount: Number(toMajorUnitsString(input.amountMinor, currency)),
          refundReason: input.reason.slice(0, 200),
        },
      });
      const body = requireOk('monnify', response, 'refund');
      const result = asRecord(pick(body, 'responseBody')) ?? {};
      const statusWord = (asString(result.refundStatus) ?? '').toUpperCase();
      return {
        providerReference: asString(result.refundReference) ?? transactionReference,
        status: statusWord === 'COMPLETED' || statusWord === 'SUCCESSFUL' ? 'succeeded' : 'pending',
        amountMinor: input.amountMinor,
        raw: body,
      };
    },

    async chargeAuthorization(): Promise<VerifiedTransaction> {
      // Declared honestly: Monnify's recurring debit needs an explicit mandate.
      throw new CapabilityUnsupportedError('monnify', 'automatic recurring charges');
    },

    verifyWebhook(input: WebhookInput): WebhookVerdict {
      if (config.webhookSecret === '') {
        return { valid: false, reason: 'No Monnify webhook secret is configured.' };
      }
      const presented = headerValue(input.headers, 'monnify-signature');
      if (presented === '')
        return { valid: false, reason: 'The monnify-signature header is missing.' };
      const expected = hmacHex(config.webhookSecret, input.rawBody);
      return safeEqual(presented, expected)
        ? { valid: true, reason: null }
        : { valid: false, reason: 'The signature does not match the body.' };
    },

    parseWebhook(input: { rawBody: string }): NormalizedEvent {
      const parsed = asRecord(JSON.parse(input.rawBody) as unknown) ?? {};
      const body = asRecord(parsed.eventData) ?? {};
      const eventType = asString(parsed.eventType) ?? 'unknown';
      const status = monnifyStatus(asString(body.paymentStatus));
      const id =
        asString(body.transactionReference) ??
        asString(body.paymentReference) ??
        asString(parsed.eventType);
      return {
        eventId: `monnify:${eventType}:${id}`,
        eventType,
        reference: asString(body.paymentReference),
        amountMinor: null,
        currency: asString(body.currency),
        status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
        occurredAt: asString(body.paidOn) ?? asString(parsed.createdOn),
        raw: parsed,
      };
    },
  };
}

export function createAdapter(config: AdapterConfig): ProviderAdapter {
  switch (config.provider) {
    case 'paystack':
      return createPaystackAdapter(config);
    case 'flutterwave':
      return createFlutterwaveAdapter(config);
    case 'monnify':
      return createMonnifyAdapter(config);
  }
}

/** The mode a set of credentials runs in, from the adapter's own declaration. */
export function modeOf(adapter: ProviderAdapter): PaymentMode {
  return adapter.mode;
}

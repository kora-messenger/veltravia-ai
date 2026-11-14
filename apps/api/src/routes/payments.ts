/**
 * Payment routes (Step 61).
 *
 * Three surfaces, and the split is the security model:
 *
 *  - **Owner routes** (`/api/payments/...`) speak only for the caller. There is
 *    no owner parameter in an owner route, so one account cannot read another's
 *    invoices, refunds or payment method even by spoofing a body field.
 *  - **Webhook routes** (`/api/payments/webhook/...`) are public by necessity and
 *    therefore prove themselves differently: the signature is checked over the
 *    exact bytes received before anything in the payload is read, and the owner
 *    comes from the intent this server issued, never from the body.
 *  - **Operator routes** (`/admin/...`) need the deployment's operator token and
 *    refuse with 503 when none is configured rather than falling open. They are
 *    the only place a price, a provider, a tax or a refund can be written.
 *
 * Nothing here trusts a browser for an amount, a workspace or a status. The
 * checkout body names a plan, an interval and a provider; the price, the tax, the
 * currency and the total come from rows.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { PaymentError } from '@veltravia/payments-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { PaymentService } from '../payment-service.js';

export interface PaymentRouteDeps {
  readonly payments: PaymentService;
  /** Read so a plan's allowance can be shown beside its price. */
  readonly subscriptions?: {
    catalogue(): Promise<
      readonly { id: string; name: string; visible: boolean; active: boolean }[]
    >;
  };
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PaymentError) {
    return reply
      .status(error.status)
      .send({ error: { code: error.code, message: error.message, ...error.details } });
  }
  const shaped = error as { code?: unknown; status?: unknown; message?: unknown };
  if (shaped !== null && typeof shaped === 'object' && typeof shaped.code === 'string') {
    const status = typeof shaped.status === 'number' ? shaped.status : 400;
    return reply.status(status).send({
      error: {
        code: shaped.code,
        message: typeof shaped.message === 'string' ? shaped.message : 'That request was refused.',
      },
    });
  }
  return reply.status(503).send({
    error: {
      code: 'PAYMENTS_UNAVAILABLE',
      message: 'Billing could not be read just now. Nothing was charged and nothing was changed.',
    },
  });
}

export function registerPaymentRoutes(
  app: FastifyInstance,
  deps: PaymentRouteDeps,
  env: NodeJS.ProcessEnv,
): void {
  const { payments } = deps;

  /**
   * Operator gate. No token configured means the financial surface is closed,
   * because a price or a refund anybody can write is not a control.
   */
  const operator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const expected = (
      env.VELTRAVIA_BILLING_ADMIN_TOKEN ??
      env.VELTRAVIA_USAGE_ADMIN_TOKEN ??
      ''
    ).trim();
    if (expected === '') {
      reply.status(503).send({
        error: {
          code: 'BILLING_ADMIN_DISABLED',
          message: 'This deployment has no operator token, so billing management is closed.',
        },
      });
      return false;
    }
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const header = request.headers['x-veltravia-admin'];
    const token =
      bearer.length > 0
        ? bearer
        : typeof header === 'string'
          ? header
          : Array.isArray(header)
            ? header[0]
            : undefined;
    if (token !== expected) {
      reply.status(403).send({
        error: { code: 'BILLING_ADMIN_DENIED', message: 'That operator token is not valid.' },
      });
      return false;
    }
    return true;
  };

  const actorOf = (request: FastifyRequest): string =>
    str(request.headers['x-veltravia-actor']) ?? `operator:${request.ip}`;

  /* ----------------------------------------------------------------- public */

  /**
   * The plan screen needs prices before anybody checks out, and a price is
   * public information. Nothing here is per-owner, so nothing here needs a
   * session.
   */
  app.get('/api/payments/prices', async (_request, reply) => {
    try {
      const [prices, providers, taxes] = await Promise.all([
        payments.prices(),
        payments.providers(),
        payments.taxes(),
      ]);
      const plans = deps.subscriptions === undefined ? [] : await deps.subscriptions.catalogue();
      return {
        prices: prices.filter((price) => price.active),
        providers: providers.filter((provider) => provider.enabled && provider.configured),
        plans: plans
          .filter((plan) => plan.visible && plan.active)
          .map((plan) => ({ id: plan.id, name: plan.name })),
        taxes: taxes
          .filter((tax) => tax.active)
          .map((tax) => ({ name: tax.name, country: tax.country, rateBps: tax.rateBps })),
        note: 'Prices are configuration for this deployment. The amount is decided by the server at checkout.',
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ------------------------------------------------------------------ owner */

  app.get('/api/payments', async (request, reply) => {
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      await payments.ensure();
      return await payments.overview(ownerRef);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/quote', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const planId = str(body.planId);
      const interval = str(body.interval);
      if (planId === undefined) {
        throw new PaymentError('PLAN_REQUIRED', 'Choose a plan to price.', 400);
      }
      if (interval === undefined) {
        throw new PaymentError('INTERVAL_REQUIRED', 'Choose monthly or yearly billing.', 400);
      }
      await payments.ensure();
      return await payments.quote({
        ownerRef,
        planId,
        interval,
        currency: str(body.currency) ?? null,
        discountCode: str(body.discountCode) ?? null,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/checkout', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const planId = str(body.planId);
      const interval = str(body.interval);
      const provider = str(body.provider);
      if (planId === undefined || interval === undefined || provider === undefined) {
        throw new PaymentError(
          'CHECKOUT_INCOMPLETE',
          'A checkout needs a plan, a billing interval and a payment method.',
          400,
        );
      }
      await payments.ensure();
      const checkout = await payments.checkout({
        ownerRef,
        planId,
        interval,
        provider,
        currency: str(body.currency) ?? null,
        discountCode: str(body.discountCode) ?? null,
        email: str(body.email) ?? null,
        name: str(body.name) ?? null,
        country: str(body.country) ?? null,
        workspaceId: str(body.workspaceId) ?? null,
      });
      return reply.status(201).send(checkout);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * The redirect's landing call. It never trusts `?reference=` alone: the server
   * asks the provider and only then grants.
   */
  app.post('/api/payments/confirm', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const reference = str(body.reference);
      if (reference === undefined) {
        throw new PaymentError('REFERENCE_REQUIRED', 'A payment reference is required.', 400);
      }
      const result = await payments.confirm({ ownerRef, reference });
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/renew', async (request, reply) => {
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      return await payments.chargeRenewal({ ownerRef, actor: `owner:${ownerRef}` });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/notifications/read', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === 'string')
        : undefined;
      const marked = await payments.markNotificationsRead(ownerRef, ids);
      return { marked };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/payments/invoices/:invoiceId', async (request, reply) => {
    const params = request.params as { invoiceId?: string };
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const invoice = await payments.invoice(ownerRef, params.invoiceId ?? '');
      return { invoice };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/payments/invoices/:invoiceId/pdf', async (request, reply) => {
    const params = request.params as { invoiceId?: string };
    const query = request.query as { kind?: string };
    try {
      const ownerRef = resolveCallerOwnerRef(request);
      const kind = query.kind === 'receipt' ? 'receipt' : 'invoice';
      const file = await payments.invoicePdf(ownerRef, params.invoiceId ?? '', kind);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .send(file.bytes);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* --------------------------------------------------------------- operator */

  app.get('/api/payments/admin/overview', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const [providers, prices, discounts, taxes, transactions, events, audit, due] =
        await Promise.all([
          payments.providers(),
          payments.prices(),
          payments.discounts(),
          payments.taxes(),
          payments.transactions({ limit: 50 }),
          payments.events(50),
          payments.platformAudit(50),
          payments.renewalsDue(25),
        ]);
      return {
        providers,
        prices,
        discounts,
        taxes,
        transactions,
        events,
        audit,
        renewalsDue: due,
        refundPolicy: payments.refundPolicy,
        durable: payments.durable,
        note: 'Secrets are never returned. Only the names of the environment variables holding them appear here.',
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/providers', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const provider = str(body.provider);
      if (provider === undefined) {
        throw new PaymentError('PROVIDER_REQUIRED', 'Name the provider to configure.', 400);
      }
      const saved = await payments.configureProvider({
        provider,
        ...(str(body.mode) === undefined ? {} : { mode: str(body.mode) as string }),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(str(body.displayName) === undefined
          ? {}
          : { displayName: str(body.displayName) as string }),
        ...(body.publicKey === null || typeof body.publicKey === 'string'
          ? { publicKey: body.publicKey as string | null }
          : {}),
        ...(str(body.secretKeyEnv) === undefined
          ? {}
          : { secretKeyEnv: str(body.secretKeyEnv) as string }),
        ...(str(body.webhookSecretEnv) === undefined
          ? {}
          : { webhookSecretEnv: str(body.webhookSecretEnv) as string }),
        ...(Array.isArray(body.currencies)
          ? {
              currencies: body.currencies.filter(
                (code): code is string => typeof code === 'string',
              ),
            }
          : {}),
        actor: actorOf(request),
      });
      return { provider: saved };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/prices', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return { price: await payments.savePrice({ draft: request.body, actor: actorOf(request) }) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/discounts', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return {
        discount: await payments.saveDiscount({ draft: request.body, actor: actorOf(request) }),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/taxes', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return { tax: await payments.saveTax({ draft: request.body, actor: actorOf(request) }) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * A refund is two facts: somebody asked, and somebody approved. This route
   * requires both, and the service refuses without the approval flag rather than
   * treating a missing field as consent.
   */
  app.post('/api/payments/admin/refunds', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const transactionId = str(body.transactionId);
      const reason = str(body.reason);
      if (transactionId === undefined) {
        throw new PaymentError('TRANSACTION_REQUIRED', 'Name the payment to refund.', 400);
      }
      if (reason === undefined) {
        throw new PaymentError('REFUND_REASON_REQUIRED', 'A refund needs a reason.', 400);
      }
      const amount = num(body.amountMinor);
      const refund = await payments.refund({
        transactionId,
        ...(amount === undefined ? {} : { amountMinor: Math.trunc(amount) }),
        reason,
        actor: actorOf(request),
        approve: body.approve === true,
        note: str(body.note) ?? null,
      });
      return reply.status(201).send({ refund });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/reconcile', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return await payments.reconcile({ actor: actorOf(request), limit: 50 });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/renewals', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const due = await payments.renewalsDue(25);
      const results: { ownerRef: string; charged: boolean; reason: string }[] = [];
      for (const entry of due) {
        const result = await payments.chargeRenewal({
          ownerRef: entry.ownerRef,
          actor: actorOf(request),
        });
        results.push({ ownerRef: entry.ownerRef, charged: result.charged, reason: result.reason });
      }
      return { checked: due.length, results };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/payments/admin/reminders', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return await payments.sendRenewalReminders();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/payments/admin/transactions', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    const query = request.query as { status?: string; provider?: string; limit?: string };
    try {
      return {
        transactions: await payments.transactions({
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.provider === undefined ? {} : { provider: query.provider }),
          limit: num(query.limit) ?? 50,
        }),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/payments/admin/events', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    const query = request.query as { status?: string; limit?: string };
    try {
      return { events: await payments.events(num(query.limit) ?? 50, query.status) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/payments/admin/audit', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    const query = request.query as { ownerRef?: string; limit?: string };
    try {
      const limit = num(query.limit) ?? 50;
      const ownerRef = str(query.ownerRef);
      return {
        audit:
          ownerRef === undefined
            ? await payments.platformAudit(limit)
            : await payments.audit(ownerRef, limit),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------------------------------------------------------------- webhook */

  /*
   * A separate encapsulated context, because a webhook has to see the **exact
   * bytes** the provider signed. Fastify's JSON parser discards them by default,
   * and re-serializing would produce a body whose HMAC does not match - so the
   * parser here keeps the raw text on the request and parses it itself. The
   * override lives in this child scope only; every other route keeps the standard
   * parser and its limits.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1_048_576 },
      (request, body, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        (request as FastifyRequest & { rawBody?: string }).rawBody = text;
        try {
          done(null, JSON.parse(text) as unknown);
        } catch {
          // The signature check decides whether an unparseable body matters.
          done(null, {});
        }
      },
    );

    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const params = request.params as { provider?: string; mode?: string };
      const rawBody =
        (request as FastifyRequest & { rawBody?: string }).rawBody ??
        (request.body === undefined ? '' : JSON.stringify(request.body));
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }
      const result = await payments.handleWebhook({
        provider: params.provider ?? '',
        ...(params.mode === undefined ? {} : { mode: params.mode }),
        rawBody,
        headers,
      });
      return reply.status(result.status).send(result.body);
    };

    scope.post('/api/payments/webhook/:provider', handler);
    scope.post('/api/payments/webhook/:provider/:mode', handler);
  });
}

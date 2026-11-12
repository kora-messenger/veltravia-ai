/**
 * Billing operations routes (Step 57).
 *
 * Three reads, each answering a question a person or an operator actually asks:
 *
 *  - `GET /api/billing` - what is billed on this deployment, at what kind, and
 *    what is deliberately not billed and why.
 *  - `GET /api/billing/reconcile` - do the usage records and the wallet ledger
 *    agree, and is any credit stranded on an open hold.
 *  - `GET /api/billing/usage` - the infrastructure numbers this process measured,
 *    so a bandwidth or storage figure is visible while it is still buffered.
 *
 * Nothing here charges, releases or edits a balance. Those actions live on their
 * own lanes (charge, wallet, integration credit) and stay there; this route makes
 * their combined state legible without inventing a second way to move money.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';

import type { InfrastructureMetering } from '../infrastructure-metering.js';
import type { UnifiedBilling } from '../unified-billing.js';
import type { UsageService } from '../usage-service.js';

export interface BillingRouteDeps {
  readonly billing: UnifiedBilling;
  readonly metering: InfrastructureMetering;
  readonly usage: UsageService;
}

const ownerOf = (request: FastifyRequest): string => {
  const header = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
};

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  /** The registry: every billable operation, and the honest gaps. */
  app.get('/api/billing', async () => {
    const capabilities = deps.billing.capabilities();
    const usage = deps.usage.capabilities();
    return {
      operations: capabilities.operations,
      lanes: capabilities.lanes,
      gaps: capabilities.gaps,
      infrastructure: {
        categories: usage.categories,
        enforcement: usage.enforcement,
        notes: usage.notes,
        sampled: deps.metering.stats(),
      },
      defaults: true,
      note: 'Prices are configurable defaults published by the charging policy, not a market price list.',
    };
  });

  /** Cross-lane reconciliation for one account. */
  app.get('/api/billing/reconcile', async (request) => {
    const ownerRef = ownerOf(request);
    return deps.billing.reconcile(ownerRef);
  });

  /**
   * The infrastructure measurement as this process sees it right now, next to
   * what has already been written. A buffered bandwidth sample is not a charge
   * yet, and saying so is the point.
   */
  app.get('/api/billing/usage', async (request) => {
    const ownerRef = ownerOf(request);
    const records = await deps.usage.records(ownerRef, { limit: 50 });
    const snapshot = await deps.usage.snapshot(ownerRef);
    return {
      ownerRef,
      live: {
        streams: deps.metering.liveStreams(ownerRef),
        ...deps.metering.stats(),
      },
      snapshot,
      records,
      note: 'Records are written from what this process observed. A category whose status is not "measured" is a floor, not a bill.',
    };
  });
}

/**
 * Plan enforcement, in one place.
 *
 * The rule this file exists for: **hiding a button is not a restriction.** Every
 * route family that starts work a plan governs is listed here with the
 * entitlement it needs, and one `onRequest` hook checks the caller's plan before
 * the route body runs. A hand-written fetch, a saved link or a script gets the
 * same answer as the screen does.
 *
 * Three properties matter more than the table itself:
 *
 *  - **Unknown routes are untouched.** Only the prefixes listed here are gated,
 *    so the billing, wallet, subscription and health surfaces cannot be locked
 *    out by a plan.
 *  - **It fails closed only on its own question.** If the plan cannot be read,
 *    the request is refused with 503 rather than allowed: an entitlement check
 *    that fails open is decoration. The error says the plan could not be read,
 *    which is different from "your plan does not include this".
 *  - **The development allowance is a real plan.** It grants what this build
 *    already ships, so an account with no subscription is unaffected - which is
 *    correct, because Step 60 must not take working functionality away.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { checkEntitlement, type EffectivePlan } from '@veltravia/subscriptions-core';

import { resolveCallerOwnerRef } from './project-access.js';
import type { SubscriptionService } from './subscription-service.js';

export interface FeatureGate {
  /** The path prefix the gate covers. Matched on the start of the URL path. */
  readonly prefix: string;
  /** The entitlement a caller needs. */
  readonly entitlement: string;
  /** What the feature is called, for the refusal. */
  readonly label: string;
}

/**
 * The table, and the only place a new protected feature has to be added.
 *
 * Order does not matter: the first prefix that matches wins, and no two entries
 * overlap.
 */
export const FEATURE_GATES: readonly FeatureGate[] = [
  { prefix: '/api/coding', entitlement: 'features.coding_agent', label: 'the coding agent' },
  { prefix: '/api/workers', entitlement: 'features.superagent', label: 'Superagent workers' },
  {
    prefix: '/api/worker-orchestration',
    entitlement: 'features.superagent',
    label: 'Superagent workers',
  },
  { prefix: '/api/executions', entitlement: 'features.superagent', label: 'autonomous execution' },
  { prefix: '/api/tasks', entitlement: 'features.superagent', label: 'task orchestration' },
  { prefix: '/api/app-builder', entitlement: 'features.app_builder', label: 'the app builder' },
  { prefix: '/api/app-testing', entitlement: 'features.testing', label: 'application testing' },
  { prefix: '/api/testing', entitlement: 'features.testing', label: 'application testing' },
  { prefix: '/api/integrations', entitlement: 'features.integrations', label: 'integrations' },
  { prefix: '/api/connections', entitlement: 'features.integrations', label: 'connected apps' },
  { prefix: '/api/connectors', entitlement: 'features.integrations', label: 'connectors' },
  { prefix: '/api/exports', entitlement: 'features.deployment', label: 'source export' },
  { prefix: '/api/sync', entitlement: 'features.deployment', label: 'repository sync' },
  { prefix: '/api/reasoning', entitlement: 'features.reasoning', label: 'the reasoning workspace' },
];

/** The gate a request falls under, or null when it is not protected. */
export function gateFor(path: string): FeatureGate | null {
  const clean = path.split('?')[0] ?? path;
  return (
    FEATURE_GATES.find((gate) => clean === gate.prefix || clean.startsWith(`${gate.prefix}/`)) ??
    null
  );
}

const DENIED = {
  code: 'NOT_IN_PLAN',
  message: 'Your plan does not include this.',
} as const;

/** True when the plan in force grants the key. Kept here so the gate is one function. */
export function planAllows(effective: EffectivePlan, key: string): boolean {
  if (!effective.entitled) return false;
  try {
    return checkEntitlement(effective.plan, key).allowed;
  } catch {
    // An entitlement key this build does not know is a programming error, and the
    // safe answer to a programming error is "no".
    return false;
  }
}

/**
 * `service` is a getter, not the service, because the gate has to be installed
 * before the routes it protects and the service is built after them. Returning
 * undefined (a harness that never assembles billing) means the gate cannot
 * answer, and the request is refused rather than allowed.
 */
export function registerSubscriptionGuards(
  app: FastifyInstance,
  service: () => SubscriptionService | undefined,
): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const gate = gateFor(request.url);
    if (gate === null) return undefined;

    const owner = resolveCallerOwnerRef(request);
    const subscriptions = service();
    if (subscriptions === undefined) {
      return reply.status(503).send({
        error: {
          code: 'SUBSCRIPTIONS_UNAVAILABLE',
          message: 'Plans are not wired in this deployment, so this request was not started.',
        },
      });
    }
    let effective: EffectivePlan;
    try {
      effective = await subscriptions.effective(owner);
    } catch {
      return reply.status(503).send({
        error: {
          code: 'SUBSCRIPTIONS_UNAVAILABLE',
          message: 'Your plan could not be read, so this request was not started. Try again.',
        },
      });
    }

    if (!effective.entitled) {
      return reply.status(403).send({
        error: {
          code: 'SUBSCRIPTION_INACTIVE',
          message:
            effective.reason ??
            'Your subscription is not active, so this feature is unavailable right now.',
          planId: effective.plan.id,
          status: effective.status,
        },
      });
    }

    if (!planAllows(effective, gate.entitlement)) {
      return reply.status(403).send({
        error: {
          ...DENIED,
          message: `The ${effective.plan.name} plan does not include ${gate.label}.`,
          entitlement: gate.entitlement,
          planId: effective.plan.id,
        },
      });
    }
    return undefined;
  });
}

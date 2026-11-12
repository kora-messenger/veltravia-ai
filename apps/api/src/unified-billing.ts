/**
 * Unified automatic billing (Step 57).
 *
 * Steps 52-56 each built one lane: usage metering, the credit wallet, message
 * credits, operation billing for long-running work, and integration credits.
 * This file is the **one place** that decides whether a billable operation may
 * start, what it reserves, and how it is settled - so an operation cannot reach
 * a provider without passing a gate, and two lanes cannot charge for the same
 * work twice.
 *
 * It is deliberately thin. It owns no ledger, no rate table and no arithmetic:
 *
 *  - the price comes from Step 54's charging catalog (`messageCredits`);
 *  - the hold, the tally and the settlement come from Step 55's operation
 *    billing, which is idempotent per operation id;
 *  - the money moves through Step 53's wallet, the only thing that writes
 *    balances;
 *  - external work keeps its own lane (Step 56) and is reconciled here.
 *
 * Three behaviours this file adds on top of those lanes:
 *
 *  1. **A registered operation.** Every billable entry point is listed below with
 *     its interaction kind, its attribution and - for the ones that are not
 *     credit-billed - the reason. An unknown operation id is refused rather than
 *     billed opaquely.
 *  2. **A refusal that explains itself.** Before a hold is taken the balance is
 *     compared with the price, and a shortfall produces `BILLING_INSUFFICIENT_CREDITS`
 *     naming the operation, the credits required, what is available and what is
 *     still usable. The work never starts, so nothing is incurred.
 *  3. **Reconciliation across lanes.** One call answers "do the usage records and
 *     the ledger agree, and are any holds stranded" without a person reading four
 *     endpoints.
 */

import type { InteractionKind } from '@veltravia/message-credits-core';

import type { IntegrationCreditService } from './integration-credit-service.js';
import type { MessageCreditService } from './message-credit-service.js';
import type {
  OperationBilling,
  OperationRef,
  OperationSettlement,
  OperationUsage,
} from './operation-billing.js';
import type { WalletService } from './wallet-service.js';

/**
 * Every operation this platform can bill, and what happens to it.
 *
 * `charged` - a credit price exists (Step 54's catalog) and a hold is taken.
 * `exempt` - real work, but the existing BIYOK/external policy says the caller's
 *   own provider account pays, so no Veltravia credit is owed. It is still metered.
 * `metered` - infrastructure only: priced by Step 52's quota, never by credits.
 * `unwired` - a known gap. Stated here on purpose so it cannot be forgotten.
 */
export type BillingOperationId =
  | 'chat'
  | 'coding'
  | 'worker'
  | 'agent-run'
  | 'reasoning'
  | 'connector'
  | 'background-job'
  | 'document-job'
  | 'intelligence-synthesis';

export type BillingTreatment = 'charged' | 'byok-exempt' | 'metered' | 'unwired';

export interface BillingOperationDefinition {
  readonly operation: BillingOperationId;
  readonly label: string;
  /** The Step 54 interaction kind, when this operation is priced by credits. */
  readonly kind: InteractionKind | null;
  readonly treatment: BillingTreatment;
  /** Where it enters the API, for the operator reading this list. */
  readonly entry: string;
  /** Attribution a charge from this operation carries. */
  readonly attribution: readonly string[];
  readonly note: string;
}

export const BILLING_OPERATIONS: readonly BillingOperationDefinition[] = [
  {
    operation: 'chat',
    label: 'Chat turn',
    kind: 'chat.message',
    treatment: 'charged',
    entry: 'POST /api/ai/execute',
    attribution: ['owner', 'conversation', 'project', 'run', 'model'],
    note: 'Held before the provider call, settled from the tokens the provider reported.',
  },
  {
    operation: 'coding',
    label: 'Coding run',
    kind: 'coding.run',
    treatment: 'charged',
    entry: 'POST /api/coding/runs',
    attribution: ['owner', 'project', 'workspace', 'run', 'model'],
    note: 'One charge per run; every model call in the run is tallied into it.',
  },
  {
    operation: 'worker',
    label: 'Superagent worker',
    kind: 'agent.execution',
    treatment: 'charged',
    entry: 'POST /api/workers/:workerId/start',
    attribution: ['owner', 'project', 'task', 'worker', 'model'],
    note: 'Held before the worker starts; settled on review accept, released otherwise.',
  },
  {
    operation: 'agent-run',
    label: 'Agent run',
    kind: 'agent.run',
    treatment: 'charged',
    entry: 'POST /api/agents/run',
    attribution: ['owner', 'project', 'workspace', 'run', 'model'],
    note: 'Held before the agent loop starts; settled when the run reaches a terminal state.',
  },
  {
    operation: 'reasoning',
    label: 'Reasoning run',
    kind: 'reasoning.run',
    treatment: 'charged',
    entry: 'POST /api/reasoning/runs',
    attribution: ['owner', 'project', 'run', 'model'],
    note: 'Held before the engine starts; settled from the run usage it reports, released on cancel or failure.',
  },
  {
    operation: 'connector',
    label: 'Connector operation',
    kind: null,
    treatment: 'charged',
    entry: 'POST /api/integrations/:id/operations',
    attribution: ['owner', 'integration', 'connector', 'operation'],
    note: 'Step 56 lane: priced by the integration catalog against the same wallet, reconciled here.',
  },
  {
    operation: 'background-job',
    label: 'Background job / execution intake',
    kind: 'background.task',
    treatment: 'metered',
    entry: 'POST /api/executions',
    attribution: ['owner', 'project', 'execution'],
    note: 'Metered by Step 52 (job count and concurrency). The Primary Agent plans deterministically, so it makes no paid model call of its own; its workers are charged as worker operations.',
  },
  {
    operation: 'document-job',
    label: 'Document reasoning job',
    kind: null,
    treatment: 'byok-exempt',
    entry: 'POST /api/documents/jobs',
    attribution: ['owner', 'project', 'job'],
    note: 'Runs on the caller’s own provider key inside the document engine. Step 52 records the tokens; no Veltravia credit price is configured for this kind, so nothing is owed. Extension point: call unifiedBilling.open() from the job start once a price exists.',
  },
  {
    operation: 'intelligence-synthesis',
    label: 'Intelligence synthesis',
    kind: null,
    treatment: 'byok-exempt',
    entry: 'POST /api/intelligence/syntheses',
    attribution: ['owner', 'project', 'synthesis'],
    note: 'Same policy as document jobs: the owner’s key pays the provider, no Veltravia credit price is configured, and the metering record is still written.',
  },
];

const byOperation = new Map<string, BillingOperationDefinition>(
  BILLING_OPERATIONS.map((entry) => [entry.operation, entry]),
);

export function billingDefinition(operation: string): BillingOperationDefinition | null {
  return byOperation.get(operation) ?? null;
}

/** A refusal a person can act on, distinct from an internal billing failure. */
export class BillingRefusal extends Error {
  constructor(
    readonly code:
      | 'BILLING_INSUFFICIENT_CREDITS'
      | 'BILLING_UNKNOWN_OPERATION'
      | 'BILLING_REQUEST_LIMIT'
      | 'BILLING_MONTHLY_LIMIT'
      | 'BILLING_REFUSED',
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingRefusal';
  }
}

export function isBillingRefusal(value: unknown): value is BillingRefusal {
  return value instanceof BillingRefusal;
}

export interface BillingHandle {
  readonly ref: OperationRef;
  readonly operation: BillingOperationId;
  readonly treatment: BillingTreatment;
  readonly chargeId: string | null;
  readonly reservedCredits: number;
  readonly exempt: boolean;
  /** Adds one reported provider call to the operation's tally. */
  record(usage: OperationUsage): void;
  settle(): Promise<OperationSettlement>;
  release(reason: string): Promise<void>;
}

export interface BillingReconciliation {
  readonly ownerRef: string;
  readonly at: string;
  readonly wallet: { readonly consistent: boolean; readonly problems: readonly string[] };
  readonly messageCharges: {
    readonly consistent: boolean;
    readonly chargesWithoutEntry: number;
  };
  readonly integrationCharges: {
    readonly consistent: boolean;
    readonly chargesWithoutEntry: number;
  };
  readonly stranding: { readonly openHolds: number; readonly oldestHeldAt: string | null };
  readonly consistent: boolean;
  readonly checked: readonly string[];
}

export interface UnifiedBilling {
  /**
   * Asks for permission to run a billable operation and takes its hold.
   *
   * Throws `BillingRefusal` when the operation is unknown, when the balance
   * cannot cover it, or when a spending limit says no. Nothing has run at that
   * point, so a refusal costs nothing and the caller's work is untouched.
   */
  open(input: OperationRef & { readonly operation: BillingOperationId }): Promise<BillingHandle>;
  record(ref: OperationRef, usage: OperationUsage): void;
  settle(ref: OperationRef): Promise<OperationSettlement>;
  release(ref: OperationRef, reason: string): Promise<void>;
  /** The fleet view: what is billed, what is not, and why. */
  capabilities(): {
    readonly operations: readonly BillingOperationDefinition[];
    readonly lanes: readonly string[];
    readonly gaps: readonly string[];
  };
  reconcile(ownerRef: string): Promise<BillingReconciliation>;
}

export interface UnifiedBillingOptions {
  readonly messageCredits: MessageCreditService;
  readonly operationBilling: OperationBilling;
  readonly wallet: WalletService;
  readonly integrationCredits?: IntegrationCreditService | undefined;
  readonly now?: (() => Date) | undefined;
}

const MAX_REASON = 400;

export function createUnifiedBilling(options: UnifiedBillingOptions): UnifiedBilling {
  const now = options.now ?? (() => new Date());

  const definitionOrRefuse = (operation: string): BillingOperationDefinition => {
    const definition = billingDefinition(operation);
    if (definition === null) {
      throw new BillingRefusal(
        'BILLING_UNKNOWN_OPERATION',
        `"${operation}" is not a billable operation on this deployment.`,
        400,
        {
          operation,
          known: BILLING_OPERATIONS.map((entry) => entry.operation),
        },
      );
    }
    return definition;
  };

  /*
   * A handle for work that is not charged in credits. It still exists so callers
   * have one shape to branch on, and it refuses to pretend a settlement happened.
   */
  const unchargedHandle = (
    ref: OperationRef,
    definition: BillingOperationDefinition,
  ): BillingHandle => ({
    ref,
    operation: definition.operation,
    treatment: definition.treatment,
    chargeId: null,
    reservedCredits: 0,
    exempt: true,
    record: () => undefined,
    settle: async () => ({
      settled: false,
      chargeId: null,
      credits: 0,
      calls: 0,
      reason:
        definition.treatment === 'byok-exempt'
          ? 'byok-exempt: the caller’s own provider account pays for this work.'
          : `not-credit-billed: ${definition.treatment}.`,
    }),
    release: async () => undefined,
  });

  /** Maps a lane's own refusal onto the one shape the routes answer with. */
  const mapRefusal = (
    error: unknown,
    definition: BillingOperationDefinition,
  ): BillingRefusal | null => {
    const candidate = error as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const code = typeof candidate?.code === 'string' ? candidate.code : null;
    if (code === null) return null;
    const details =
      candidate.details !== null && typeof candidate.details === 'object'
        ? (candidate.details as Record<string, unknown>)
        : {};
    const message = typeof candidate.message === 'string' ? candidate.message : 'Billing refused.';
    if (code === 'INSUFFICIENT_CREDITS') {
      return new BillingRefusal(
        'BILLING_INSUFFICIENT_CREDITS',
        `${definition.label} was not started: the credit balance cannot cover it.`,
        402,
        {
          operation: definition.operation,
          operationLabel: definition.label,
          availableCredits: details['available'] ?? null,
          requiredCredits: details['required'] ?? null,
          shortfall: details['shortfall'] ?? null,
          preserved: ['projects', 'files', 'settings', 'conversation history'],
          retry: 'Add credit, lower the request, or wait for the next allowance.',
          // The wallet's own wording, kept so a support question can be answered
          // from the refusal instead of from a reproduction.
          upstream: message,
        },
      );
    }
    if (code === 'REQUEST_LIMIT_EXCEEDED') {
      return new BillingRefusal(
        'BILLING_REQUEST_LIMIT',
        `${definition.label} is above your per-request credit limit.`,
        400,
        { operation: definition.operation, ...details, upstream: message },
      );
    }
    if (code === 'MONTHLY_LIMIT_REACHED') {
      return new BillingRefusal(
        'BILLING_MONTHLY_LIMIT',
        `${definition.label} would exceed your monthly credit limit.`,
        402,
        { operation: definition.operation, ...details, upstream: message },
      );
    }
    return null;
  };

  const billing: UnifiedBilling = {
    async open(input) {
      const definition = definitionOrRefuse(input.operation);
      const ref: OperationRef = {
        ownerRef: input.ownerRef,
        kind: (definition.kind ?? input.kind) as InteractionKind,
        operationId: input.operationId,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.parentChargeId === undefined ? {} : { parentChargeId: input.parentChargeId }),
        ...(input.byok === undefined ? {} : { byok: input.byok }),
      };

      if (definition.treatment !== 'charged' || definition.kind === null) {
        return unchargedHandle(ref, definition);
      }

      /*
       * Ask the price before asking the wallet. `affordable` is the wallet's own
       * answer for the price of this kind, so the refusal a caller receives names
       * the number that is missing rather than "reserve failed".
       */
      /*
       * A first-time account has no wallet row, and a missing row is not the same
       * as a wallet that cannot pay. Opening it here means the only refusal a
       * person can receive from this gate is about credit, never about the row
       * not existing yet.
       */
      await options.wallet.ensure({ ownerRef: ref.ownerRef });

      try {
        const quote = await options.messageCredits.estimate({
          ownerRef: ref.ownerRef,
          kind: ref.kind,
          byok: ref.byok ?? true,
          // A quote is not a write: the key exists only because the pricing
          // context requires one, and nothing is stored under it.
          idempotencyKey: `quote:${definition.operation}:${input.operationId}`,
          ...(ref.workspaceId === undefined || ref.workspaceId === null
            ? {}
            : { workspaceId: ref.workspaceId }),
          ...(ref.projectId === undefined || ref.projectId === null
            ? {}
            : { projectId: ref.projectId }),
        });
        if (!quote.affordable) {
          throw new BillingRefusal(
            'BILLING_INSUFFICIENT_CREDITS',
            `${definition.label} was not started: ${quote.estimate.credits} credits are required and the wallet cannot hold them.`,
            402,
            {
              operation: definition.operation,
              operationLabel: definition.label,
              requiredCredits: quote.estimate.credits,
              availableCredits: quote.walletAvailable,
              shortfall: quote.shortfall,
              planId: quote.planId,
              // What the person keeps even though this one operation was refused.
              preserved: ['projects', 'files', 'settings', 'conversation history'],
              preservesWork: true,
              retry: 'Add credit, lower the request, or wait for the next allowance.',
            },
          );
        }
      } catch (error) {
        if (isBillingRefusal(error)) throw error;
        // An estimate that itself fails must not block work: the reserve below
        // is the authoritative, atomic check.
      }

      let ledger;
      try {
        ledger = await options.operationBilling.begin(ref);
      } catch (error) {
        const refusal = mapRefusal(error, definition);
        if (refusal !== null) throw refusal;
        throw error;
      }

      return {
        ref,
        operation: definition.operation,
        treatment: definition.treatment,
        chargeId: ledger.chargeId,
        reservedCredits: 0,
        exempt: ledger.exempt,
        record: (usage) => options.operationBilling.record(ref, usage),
        settle: () => options.operationBilling.settle(ref),
        release: async (reason) => {
          await options.operationBilling.abandon(ref, reason.slice(0, MAX_REASON));
        },
      };
    },

    record: (ref, usage) => options.operationBilling.record(ref, usage),
    settle: (ref) => options.operationBilling.settle(ref),
    release: (ref, reason) => options.operationBilling.abandon(ref, reason.slice(0, MAX_REASON)),

    capabilities: () => ({
      operations: BILLING_OPERATIONS,
      lanes: [
        'Step 52: infrastructure metering (tokens, storage, bandwidth, realtime, execution time, jobs)',
        'Step 53: credit wallet (the only writer of balances, with reservations and refunds)',
        'Step 54: message-credit charging policy (the only price table)',
        'Step 55: operation billing (one charge per long-running operation)',
        'Step 56: integration credits (external work against the same wallet)',
        'Step 57: this coordinator (eligibility, refusal, reconciliation)',
      ],
      gaps: BILLING_OPERATIONS.filter((entry) => entry.treatment === 'unwired').map(
        (entry) => `${entry.label}: ${entry.note}`,
      ),
    }),

    async reconcile(ownerRef) {
      const at = now().toISOString();
      // An account nobody has metered yet has no wallet row. That is not an
      // inconsistency, so the wallet is opened before it is reconciled.
      const wallet = await options.wallet
        .ensure({ ownerRef })
        .then(() => options.wallet.reconcile({ ownerRef }));
      const message = await options.messageCredits.integrity({ ownerRef });
      const integration =
        options.integrationCredits === undefined
          ? { chargesWithoutEntry: 0, consistent: true, wallet: null }
          : await options.integrationCredits.integrity({ ownerRef });
      const held = await options.wallet.held({ ownerRef });
      const oldest = held
        .map((reservation) => reservation.createdAt)
        .filter((value): value is string => typeof value === 'string')
        .sort()[0];

      const problems = Array.isArray(wallet.problems) ? wallet.problems : [];
      const consistent =
        wallet.consistent && message.consistent && integration.consistent && problems.length === 0;

      return {
        ownerRef,
        at,
        wallet: { consistent: wallet.consistent, problems },
        messageCharges: {
          consistent: message.consistent,
          chargesWithoutEntry: message.chargesWithoutEntry,
        },
        integrationCharges: {
          consistent: integration.consistent,
          chargesWithoutEntry: integration.chargesWithoutEntry,
        },
        stranding: { openHolds: held.length, oldestHeldAt: oldest ?? null },
        consistent,
        checked: [
          'wallet ledger sums equal the stored balances',
          'every committed message charge names a wallet entry that exists',
          'every committed integration charge names a wallet entry that exists',
          'open holds are counted so a stranded reservation is visible',
        ],
      };
    },
  };

  return billing;
}

/** One helper so every route answers a billing refusal the same way. */
export function billingErrorBody(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: Record<string, unknown> } };
} {
  if (isBillingRefusal(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  if (
    typeof candidate?.code === 'string' &&
    typeof candidate.status === 'number' &&
    typeof candidate.message === 'string'
  ) {
    return {
      status: candidate.status,
      body: { error: { code: candidate.code, message: candidate.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'BILLING_INTERNAL',
        message: 'The billing request could not be completed.',
      },
    },
  };
}

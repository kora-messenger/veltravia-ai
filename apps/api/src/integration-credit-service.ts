/**
 * Integration credits (Step 56).
 *
 * Third-party work is charged here and nowhere else, and always in the same
 * order:
 *
 *  1. **Classify.** Which policy covers this integration and operation, and is
 *     the work free, paid, or billed to the user's own external account?
 *  2. **Estimate.** A price from that policy plus what the caller declared.
 *     Uncertain estimates are labelled as lower bounds, never rounded up.
 *  3. **Hold.** Credit is reserved in the Step 53 wallet *before* the external
 *     call, so an operation that cannot be paid for is refused before it costs
 *     anything. A free, externally billed or BYOK operation is written as
 *     `exempt` instead, with the reason on the row.
 *  4. **Settle.** The measured operation is priced and posted to the ledger; the
 *     unused part of the hold goes back.
 *  5. **Release.** A failed, refused, cancelled or timed-out operation returns
 *     its hold. An operation nobody came back for is swept after its TTL.
 *
 * Two invariants make the whole thing safe to retry: a charge is written once per
 * idempotency key, and money only moves through the wallet ledger, which has its
 * own idempotency and reservation guarantees.
 *
 * This service prices *external work*. Provider tokens belong to Step 52, 54 and
 * 55; a service that bills the caller's own account is never charged here unless
 * the policy explicitly authorises it.
 */

import {
  type BillingClass,
  type ChargeFilter,
  type ChargeState,
  type IntegrationBillingCatalog,
  type IntegrationBillingPolicy,
  type IntegrationCharge,
  type IntegrationChargeDraft,
  type IntegrationCreditStore,
  type IntegrationMeasurement,
  type IntegrationOperationKind,
  type IntegrationSpendingSettings,
  type MeasurementUnit,
  type UsageDimension,
  type UsageGroup,
  computeIntegrationCharge,
  creditRound,
  estimateIntegrationCharge,
  IntegrationCreditError,
  isIntegrationOperationKind,
  parseIntegrationBillingCatalog,
  planBilling,
  resolveIntegrationPolicy,
} from '@veltravia/integration-credits-core';

import { InMemoryIntegrationCreditStore } from '@veltravia/integration-credits-core';

import type { WalletService } from './wallet-service.js';

const DEFAULT_HOLD_TTL_SECONDS = 900;

export interface WalletRef {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
}

/** Everything the platform knows about an external operation before it runs. */
export interface IntegrationChargeContext extends WalletRef {
  readonly kind: IntegrationOperationKind;
  readonly operationId: string;
  readonly integrationId?: string | null;
  readonly connectorId?: string | null;
  readonly pluginId?: string | null;
  readonly connectionId?: string | null;
  readonly projectId?: string | null;
  /** The run, worker, task or execution this operation serves. */
  readonly executionId?: string | null;
  /** The single tool invocation this operation belongs to. */
  readonly requestId?: string | null;
  /** Caller-supplied deduplication key. Without one, each attempt is its own charge. */
  readonly idempotencyKey?: string | null;
  readonly byok?: boolean;
  readonly credential?: 'platform' | 'user' | null;
  readonly ttlSeconds?: number;
}

export interface IntegrationClassification {
  readonly planId: string;
  readonly policyId: string | null;
  readonly policyLabel: string | null;
  readonly billingClass: BillingClass;
  readonly billable: boolean;
  /** Why nothing is charged on a non-billable result. Null when it is billable. */
  readonly exemptReason: string | null;
}

export interface ReserveResult {
  readonly charge: IntegrationCharge;
  readonly created: boolean;
  readonly classification: IntegrationClassification;
  readonly estimate: {
    readonly credits: number;
    readonly basis: string;
    readonly lowerBound: boolean;
    readonly exempt: boolean;
  };
  readonly reservationId: string | null;
  readonly walletAvailable: number;
}

export interface CommitResult {
  readonly charge: IntegrationCharge;
  readonly credits: number;
  readonly released: number;
  readonly aboveHold: number;
  readonly aboveHoldCovered: boolean;
}

export interface IntegrationMonthUsage {
  readonly charges: number;
  readonly credits: number;
  readonly refunded: number;
  readonly exempt: number;
  readonly open: number;
  readonly openCredits: number;
  readonly requests: number;
  readonly units: number;
  readonly byBillingClass: readonly UsageGroup[];
  readonly byIntegration: readonly UsageGroup[];
}

/**
 * The seam the integration runtime calls. `bill` surrounds exactly one external
 * operation: a hold before it, a settlement after it, a release when it fails.
 */
export interface IntegrationBillingGate {
  bill<T>(context: IntegrationChargeContext, run: () => Promise<T>): Promise<T>;
}

export interface IntegrationCreditService extends IntegrationBillingGate {
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;
  readonly catalog: IntegrationBillingCatalog;
  planOf(ownerRef: string): Promise<string>;
  catalogView(): unknown;
  classify(
    input: Pick<
      IntegrationChargeContext,
      'ownerRef' | 'kind' | 'operationId' | 'integrationId' | 'connectorId' | 'byok' | 'credential'
    > & { readonly planId?: string | null },
  ): Promise<IntegrationClassification>;
  estimate(
    input: IntegrationChargeContext & {
      readonly expectedRequests?: number | null;
      readonly expectedUnits?: Partial<Record<MeasurementUnit, number | null>> | null;
    },
  ): Promise<{
    readonly estimate: ReturnType<typeof estimateIntegrationCharge>;
    readonly classification: IntegrationClassification;
    readonly walletAvailable: number;
    readonly affordable: boolean;
    readonly shortfall: number;
  }>;
  reserve(input: IntegrationChargeContext): Promise<ReserveResult>;
  commit(
    input: WalletRef & {
      readonly chargeId?: string;
      readonly reservationId?: string;
      readonly measurement: IntegrationMeasurement;
    },
  ): Promise<CommitResult>;
  release(
    input: WalletRef & {
      readonly chargeId?: string;
      readonly reservationId?: string;
      readonly reason: string;
    },
  ): Promise<IntegrationCharge>;
  refund(
    input: WalletRef & {
      readonly chargeId: string;
      readonly reason: string;
      readonly actor: string;
    },
  ): Promise<IntegrationCharge>;
  sweep(input: WalletRef): Promise<readonly IntegrationCharge[]>;
  summary(input: WalletRef): Promise<unknown>;
  charges(
    input: WalletRef,
    filter: Omit<ChargeFilter, 'limit'> & { readonly limit?: number },
  ): Promise<unknown>;
  usage(input: WalletRef, dimension: UsageDimension): Promise<readonly UsageGroup[]>;
  settings(input: WalletRef): Promise<IntegrationSpendingSettings>;
  updateSettings(
    input: WalletRef & {
      readonly monthlyLimit: number | null;
      readonly perOperationLimit: number | null;
    },
  ): Promise<IntegrationSpendingSettings>;
  integrity(input: WalletRef): Promise<{
    readonly wallet: unknown;
    readonly chargesWithoutEntry: number;
    readonly consistent: boolean;
  }>;
}

export interface IntegrationCreditServiceOptions {
  readonly store?: IntegrationCreditStore | undefined;
  readonly wallet: WalletService;
  /** The owner's plan, resolved the same way Step 52 resolves allowances. */
  readonly planOf: (ownerRef: string) => Promise<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
}

const monthStart = (at: Date): string =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

const readPositiveInt = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const totalUnits = (units: Readonly<Partial<Record<MeasurementUnit, number>>>): number =>
  Object.values(units).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);

const isUserCredential = (input: {
  readonly byok?: boolean;
  readonly credential?: 'platform' | 'user' | null;
}): boolean => input.byok === true || input.credential === 'user';

export function createIntegrationCreditService(
  options: IntegrationCreditServiceOptions,
): IntegrationCreditService {
  const env = options.env ?? process.env;
  const store = options.store ?? new InMemoryIntegrationCreditStore();
  const wallet: WalletService = options.wallet;
  const now = options.now ?? (() => new Date());
  const catalog = parseIntegrationBillingCatalog(env['VELTRAVIA_INTEGRATION_CHARGES']);
  const holdTtlSeconds = readPositiveInt(
    env,
    'VELTRAVIA_INTEGRATION_HOLD_TTL_SECONDS',
    DEFAULT_HOLD_TTL_SECONDS,
  );
  let seq = 0;
  const newId = (prefix: string): string => `${prefix}_${now().getTime().toString(36)}_${++seq}`;

  /**
   * Which purse a charge draws from.
   *
   * A workspace wallet is a real purse once somebody funds it; from then on it
   * pays its own way. An unfunded workspace is not a purse - charging its empty
   * balance refused work the account holder could plainly afford - so it defers
   * to the owner's wallet. The decision sticks because a hold moves `reserved`
   * above zero: while the charge is open, the purse it came from reads as funded,
   * so settle and release resolve the same wallet.
   */
  const refOf = async (ref: WalletRef) => {
    if (ref.workspaceId === undefined || ref.workspaceId === null) {
      return { ownerRef: ref.ownerRef };
    }
    const view = await wallet.ensure({ ownerRef: ref.ownerRef, workspaceId: ref.workspaceId });
    const funded = view.available > 0 || view.reserved > 0 || view.spent > 0;
    return funded
      ? { ownerRef: ref.ownerRef, workspaceId: ref.workspaceId }
      : { ownerRef: ref.ownerRef };
  };

  const assertAmount = (value: number, label: string): number => {
    if (!Number.isFinite(value) || value < 0) {
      throw new IntegrationCreditError(
        'INVALID_AMOUNT',
        `${label} must be a positive number.`,
        400,
      );
    }
    return creditRound(value);
  };

  const classifyWith = (
    planId: string,
    input: {
      readonly kind: IntegrationOperationKind;
      readonly integrationId?: string | null;
      readonly operationId?: string | null;
      readonly byok?: boolean;
      readonly credential?: 'platform' | 'user' | null;
    },
  ): IntegrationClassification => {
    const plan = planBilling(catalog, planId);
    const policy: IntegrationBillingPolicy | null = resolveIntegrationPolicy(plan, {
      kind: input.kind,
      integrationId: input.integrationId ?? null,
      operationId: input.operationId ?? null,
    });
    const billingClass = policy?.billingClass ?? 'free';
    const userCredential = isUserCredential(input);
    const externallyBlocked =
      billingClass === 'externally-billed' && policy?.chargeExternallyBilled !== true;
    const byokBlocked = userCredential && policy?.chargeByok !== true;
    const billable = plan.billable && !externallyBlocked && !byokBlocked && billingClass === 'paid';
    return {
      planId: plan.planId,
      policyId: policy?.id ?? null,
      policyLabel: policy?.label ?? null,
      billingClass,
      billable,
      exemptReason: billable
        ? null
        : plan.billable
          ? billingClass === 'free'
            ? 'The integration is free.'
            : externallyBlocked
              ? 'The service bills your own external account, so no Veltravia credits are charged.'
              : byokBlocked
                ? 'The call used your own credential, so its cost is on your own account.'
                : 'Nothing to charge.'
          : 'This plan does not charge for integration work.',
    };
  };

  const policyFor = async (input: {
    readonly ownerRef: string;
    readonly kind: IntegrationOperationKind;
    readonly integrationId?: string | null;
    readonly operationId?: string | null;
  }) => {
    const planId = await options.planOf(input.ownerRef);
    const plan = planBilling(catalog, planId);
    return {
      planId,
      plan,
      policy: resolveIntegrationPolicy(plan, {
        kind: input.kind,
        integrationId: input.integrationId ?? null,
        operationId: input.operationId ?? null,
      }),
    };
  };

  const materialise = (
    draft: IntegrationChargeDraft,
    state: ChargeState,
    over: Partial<IntegrationCharge> = {},
  ): IntegrationCharge => ({
    id: newId('ich'),
    ownerRef: draft.ownerRef,
    workspaceId: draft.workspaceId ?? null,
    projectId: draft.projectId ?? null,
    integrationId: draft.integrationId ?? null,
    connectorId: draft.connectorId ?? null,
    pluginId: draft.pluginId ?? null,
    operationId: draft.operationId ?? null,
    executionId: draft.executionId ?? null,
    requestId: draft.requestId ?? null,
    connectionId: draft.connectionId ?? null,
    kind: draft.kind,
    billingClass: draft.billingClass,
    planId: draft.planId,
    policyId: draft.policyId,
    credits: 0,
    estimatedCredits: draft.estimatedCredits,
    state,
    basis: state === 'exempt' ? 'exempt' : 'flat',
    requests: null,
    units: {},
    durationMs: null,
    limitations: [],
    measurementSource: null,
    byok: draft.byok === true,
    idempotencyKey: draft.idempotencyKey,
    reservationId: null,
    walletEntryId: null,
    failureReason: null,
    createdAt: now().toISOString(),
    settledAt: state === 'exempt' ? now().toISOString() : null,
    refundedAt: null,
    ...over,
  });

  const save = async (
    charge: IntegrationCharge,
    expected: ChargeState,
  ): Promise<IntegrationCharge> => {
    const saved = await store.saveCharge(charge, expected);
    if (!saved) {
      // Somebody else settled this charge first; their state is the truth.
      const current = await store.findById(charge.ownerRef, charge.id);
      if (current !== null) return current;
      throw new IntegrationCreditError(
        'CHARGE_NOT_FOUND',
        'That integration charge no longer exists.',
        404,
      );
    }
    return charge;
  };

  const settingsOf = async (ref: WalletRef): Promise<IntegrationSpendingSettings> =>
    (await store.readSettings(ref.ownerRef, ref.workspaceId ?? null)) ?? {
      ownerRef: ref.ownerRef,
      workspaceId: ref.workspaceId ?? null,
      monthlyLimit: null,
      perOperationLimit: null,
      updatedAt: now().toISOString(),
    };

  const monthTotals = async (ref: WalletRef): Promise<IntegrationMonthUsage> => {
    const since = monthStart(now());
    const page = await store.listCharges(ref.ownerRef, {
      limit: 500,
      workspaceId: ref.workspaceId ?? null,
    });
    const inMonth = page.charges.filter((charge) => charge.createdAt >= since);
    const counted = inMonth.filter(
      (charge) => charge.state === 'committed' || charge.state === 'exempt',
    );
    const refunded = inMonth.filter((charge) => charge.state === 'refunded');
    const open = inMonth.filter((charge) => charge.state === 'reserved');
    const sum = (rows: readonly IntegrationCharge[], pick: (row: IntegrationCharge) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);
    // Exempt rows are counted apart: they are a real decision by the platform,
    // not a charge, and folding them into "credits" would misstate the month.
    const charged = counted.filter((charge) => charge.state === 'committed');
    return {
      charges: charged.length,
      credits: creditRound(sum(charged, (charge) => charge.credits)),
      refunded: creditRound(sum(refunded, (charge) => charge.credits)),
      exempt: counted.length - charged.length,
      open: open.length,
      openCredits: creditRound(sum(open, (charge) => charge.estimatedCredits)),
      requests: sum(counted, (charge) => charge.requests ?? 0),
      units: sum(counted, (charge) => totalUnits(charge.units)),
      byBillingClass: await store.aggregate(ref.ownerRef, 'billingClass', {
        since,
        workspaceId: ref.workspaceId ?? null,
      }),
      byIntegration: await store.aggregate(ref.ownerRef, 'integration', {
        since,
        workspaceId: ref.workspaceId ?? null,
      }),
    };
  };

  const service: IntegrationCreditService = {
    store: store.kind,
    durable: store.kind === 'postgres',
    catalog,
    planOf: options.planOf,

    catalogView() {
      return {
        version: catalog.version,
        /**
         * True when these are the shipped defaults. The dashboard prints this
         * sentence beside the numbers so nobody reads them as a price list.
         */
        defaultsOnly: catalog.defaultsOnly,
        note: catalog.defaultsOnly
          ? 'Configurable defaults shipped with Veltravia, not market prices. A deployment can replace them.'
          : 'Rates configured by this deployment.',
        currency: catalog.currency,
        holdTtlSeconds,
        classes: [
          {
            billingClass: 'free',
            label: 'Free',
            meaning: 'Costs nothing to run. Never charged and never held.',
          },
          {
            billingClass: 'paid',
            label: 'Paid',
            meaning: 'The platform provides the credential, so the operation is priced in credits.',
          },
          {
            billingClass: 'externally-billed',
            label: 'Billed to your own account',
            meaning:
              'The external service charges you directly. Veltravia charges no credits unless a policy says otherwise.',
          },
        ],
        plans: catalog.plans.map((plan) => ({
          planId: plan.planId,
          label: plan.label,
          billable: plan.billable,
          policies: plan.policies.map((policy) => ({
            id: policy.id,
            label: policy.label,
            kind: policy.kind,
            integrationId: policy.integrationId,
            operationId: policy.operationId,
            billingClass: policy.billingClass,
            perOperation: policy.perOperation,
            perRequest: policy.perRequest,
            rates: policy.rates.map((rate) => ({
              unit: rate.unit,
              creditsPerUnit: rate.creditsPerUnit,
            })),
            chargeExternallyBilled: policy.chargeExternallyBilled,
            chargeByok: policy.chargeByok,
          })),
        })),
      };
    },

    async classify(input) {
      const planId = input.planId ?? (await options.planOf(input.ownerRef));
      return classifyWith(planId, input);
    },

    async estimate(input) {
      if (!isIntegrationOperationKind(input.kind)) {
        throw new IntegrationCreditError(
          'INVALID_KIND',
          `Unknown integration operation kind: ${input.kind}`,
          400,
        );
      }
      const { planId, plan, policy } = await policyFor(input);
      const classification = classifyWith(planId, input);
      const estimate = estimateIntegrationCharge({
        policy,
        billingClass: classification.billingClass,
        expectedRequests: input.expectedRequests ?? null,
        expectedUnits: input.expectedUnits ?? null,
        ...(input.byok === true ? { byok: true } : {}),
        credential: input.credential ?? null,
      });
      const balances = await wallet.overview(await refOf(input));
      const available = balances.wallet.available;
      const affordable = estimate.exempt || !plan.billable || available >= estimate.credits;
      return {
        estimate,
        classification,
        walletAvailable: available,
        affordable,
        shortfall: affordable ? 0 : creditRound(estimate.credits - available),
      };
    },

    async reserve(input) {
      if (!isIntegrationOperationKind(input.kind)) {
        throw new IntegrationCreditError(
          'INVALID_KIND',
          `Unknown integration operation kind: ${input.kind}`,
          400,
        );
      }
      const idempotencyKey =
        input.idempotencyKey !== undefined && input.idempotencyKey !== null
          ? input.idempotencyKey
          : newId('icr');
      const existing = await store.findByKey(input.ownerRef, idempotencyKey);
      if (existing !== null) {
        const balances = await wallet.overview(await refOf(input));
        return {
          charge: existing,
          created: false,
          classification: classifyWith(existing.planId, existing),
          estimate: {
            credits: existing.estimatedCredits,
            basis: existing.basis,
            lowerBound: false,
            exempt: existing.state === 'exempt',
          },
          reservationId: existing.reservationId,
          walletAvailable: balances.wallet.available,
        };
      }

      const { planId, plan, policy } = await policyFor(input);
      const classification = classifyWith(planId, input);
      const estimate = estimateIntegrationCharge({
        policy,
        billingClass: classification.billingClass,
        ...(input.byok === true ? { byok: true } : {}),
        credential: input.credential ?? null,
      });
      const settings = await settingsOf(input);

      if (settings.perOperationLimit !== null && estimate.credits > settings.perOperationLimit) {
        throw new IntegrationCreditError(
          'OPERATION_LIMIT_EXCEEDED',
          `This operation is estimated at ${estimate.credits} credits, above your per-operation limit of ${settings.perOperationLimit}.`,
          400,
          { estimated: estimate.credits, limit: settings.perOperationLimit },
        );
      }

      const month = await monthTotals(input);
      if (
        settings.monthlyLimit !== null &&
        month.credits + estimate.credits > settings.monthlyLimit
      ) {
        throw new IntegrationCreditError(
          'MONTHLY_LIMIT_EXCEEDED',
          `Your monthly integration-credit limit of ${settings.monthlyLimit} would be exceeded.`,
          402,
          { spent: month.credits, limit: settings.monthlyLimit, estimated: estimate.credits },
        );
      }

      const draft: IntegrationChargeDraft = {
        ownerRef: input.ownerRef,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        integrationId: input.integrationId ?? null,
        connectorId: input.connectorId ?? null,
        pluginId: input.pluginId ?? null,
        operationId: input.operationId ?? null,
        executionId: input.executionId ?? null,
        requestId: input.requestId ?? null,
        connectionId: input.connectionId ?? null,
        kind: input.kind,
        billingClass: classification.billingClass,
        planId,
        estimatedCredits: estimate.credits,
        policyId: classification.policyId ?? 'none',
        byok: isUserCredential(input),
        idempotencyKey,
      };

      if (!classification.billable || estimate.exempt || estimate.credits === 0) {
        const computed = computeIntegrationCharge({
          policy,
          planBillable: plan.billable,
          billingClass: classification.billingClass,
          measurement: {
            ...(input.byok === true ? { byok: true } : {}),
            credential: input.credential ?? null,
          },
        });
        const { charge } = await store.insertCharge(
          materialise(draft, 'exempt', { limitations: computed.limitations }),
        );
        const balances = await wallet.overview(await refOf(input));
        return {
          charge,
          created: true,
          classification,
          estimate,
          reservationId: null,
          walletAvailable: balances.wallet.available,
        };
      }

      // The row is written before the hold so a crash between the two leaves an
      // auditable "reserved with no hold" row the sweep can close, rather than a
      // hold nobody can explain.
      const { charge, created } = await store.insertCharge(materialise(draft, 'reserved'));
      if (!created) {
        const balances = await wallet.overview(await refOf(input));
        return {
          charge,
          created: false,
          classification,
          estimate,
          reservationId: charge.reservationId,
          walletAvailable: balances.wallet.available,
        };
      }

      let reservation;
      try {
        reservation = await wallet.reserve({
          ...(await refOf(input)),
          amount: estimate.credits,
          operationKey: `integration:${charge.id}`,
          reason: `Integration credit hold for ${input.integrationId ?? 'an integration'} ${input.operationId}.`,
          actor: 'integration-credits',
        });
      } catch (error) {
        await save(
          {
            ...charge,
            state: 'released',
            failureReason:
              error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
                ? String((error as { code?: unknown }).code)
                : 'reservation-refused',
            settledAt: now().toISOString(),
          },
          'reserved',
        );
        throw error;
      }

      const held = await save({ ...charge, reservationId: reservation.reservation.id }, 'reserved');
      const balances = await wallet.overview(await refOf(input));
      return {
        charge: held,
        created: true,
        classification,
        estimate,
        reservationId: reservation.reservation.id,
        walletAvailable: balances.wallet.available,
      };
    },

    async commit(input) {
      const charge =
        input.chargeId !== undefined
          ? await store.findById(input.ownerRef, input.chargeId)
          : input.reservationId !== undefined
            ? ((await store.listCharges(input.ownerRef, { limit: 50 })).charges.find(
                (row) => row.reservationId === input.reservationId,
              ) ?? null)
            : null;
      if (charge === null) {
        throw new IntegrationCreditError(
          'CHARGE_NOT_FOUND',
          'No integration charge matches that identifier.',
          404,
        );
      }
      if (charge.state !== 'reserved') {
        // Settling twice is not an error; it is the same answer.
        return {
          charge,
          credits: charge.credits,
          released: 0,
          aboveHold: 0,
          aboveHoldCovered: true,
        };
      }

      const { planId, plan, policy } = await policyFor({
        ownerRef: input.ownerRef,
        kind: charge.kind,
        integrationId: charge.integrationId,
        operationId: charge.operationId,
      });
      // The billing class and the credential are facts recorded at the hold; a
      // caller cannot reclassify them after the money moved.
      const classification = classifyWith(planId, {
        kind: charge.kind,
        integrationId: charge.integrationId,
        operationId: charge.operationId,
        byok: charge.byok,
        credential: input.measurement.credential ?? null,
      });
      const computed = computeIntegrationCharge({
        policy,
        planBillable: plan.billable,
        billingClass: charge.billingClass,
        measurement: {
          ...input.measurement,
          byok: charge.byok,
          ...(classification.billingClass === 'externally-billed'
            ? { credential: input.measurement.credential ?? null }
            : {}),
        },
      });

      const reservationId = charge.reservationId;
      let walletEntryId: string | null = charge.walletEntryId;
      let aboveHold = 0;
      let aboveHoldCovered = true;
      const purse = await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId });

      if (reservationId !== null && computed.credits > 0) {
        try {
          const result = await wallet.commit({
            ...purse,
            reservationId,
            amount: computed.credits,
            reason: `Integration charge for ${charge.integrationId ?? 'an integration'} ${charge.operationId ?? charge.id}.`,
            actor: 'integration-credits',
          });
          walletEntryId = result.entry.id;
          aboveHold = creditRound(Math.max(0, computed.credits - charge.estimatedCredits));
        } catch (error) {
          /*
           * The measurement came in above what was held, and the wallet could not
           * cover the difference. The hold is a floor, not a cap, but a wallet
           * must never go negative: settle the part the hold covers, and record
           * the rest as uncollected instead of pretending it was taken.
           */
          const insufficient =
            error instanceof Error && (error as { code?: unknown }).code === 'INSUFFICIENT_CREDITS';
          if (!insufficient || charge.estimatedCredits <= 0) throw error;
          const partial = await wallet.commit({
            ...purse,
            reservationId,
            amount: charge.estimatedCredits,
            reason: `Integration charge for ${charge.integrationId ?? 'an integration'} ${charge.operationId ?? charge.id} (hold only; the measurement exceeded it).`,
            actor: 'integration-credits',
          });
          walletEntryId = partial.entry.id;
          aboveHold = creditRound(computed.credits - charge.estimatedCredits);
          aboveHoldCovered = false;
        }
      } else if (reservationId !== null) {
        // Nothing is owed: give the whole hold back rather than posting a zero.
        await wallet.release({
          ...purse,
          reservationId,
          reason: 'The external operation used no chargeable credit.',
          actor: 'integration-credits',
        });
      }

      const settledState: ChargeState =
        computed.exempt || computed.credits === 0 || classification.billable === false
          ? computed.exempt
            ? 'exempt'
            : 'committed'
          : 'committed';
      const settled: IntegrationCharge = {
        ...charge,
        state: settledState,
        basis: computed.basis,
        credits: computed.credits,
        requests: computed.requests,
        units: computed.units,
        durationMs: computed.durationMs,
        limitations: computed.limitations,
        measurementSource:
          input.measurement.source ??
          (computed.requests === null && Object.keys(computed.units).length === 0
            ? 'unavailable'
            : 'platform'),
        walletEntryId,
        failureReason: aboveHoldCovered ? null : 'measurement-above-hold-uncovered',
        settledAt: now().toISOString(),
      };
      return {
        charge: await save(settled, 'reserved'),
        credits: aboveHoldCovered ? computed.credits : charge.estimatedCredits,
        released: creditRound(Math.max(0, charge.estimatedCredits - computed.credits)),
        aboveHold,
        aboveHoldCovered,
      };
    },

    async release(input) {
      const charge =
        input.chargeId !== undefined
          ? await store.findById(input.ownerRef, input.chargeId)
          : input.reservationId !== undefined
            ? ((await store.listCharges(input.ownerRef, { limit: 50 })).charges.find(
                (row) => row.reservationId === input.reservationId,
              ) ?? null)
            : null;
      if (charge === null) {
        throw new IntegrationCreditError(
          'CHARGE_NOT_FOUND',
          'No integration charge matches that identifier.',
          404,
        );
      }
      if (charge.state !== 'reserved') return charge;
      if (charge.reservationId !== null) {
        await wallet.release({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          reservationId: charge.reservationId,
          reason: input.reason,
          actor: 'integration-credits',
        });
      }
      return save(
        {
          ...charge,
          state: 'released',
          failureReason: input.reason,
          settledAt: now().toISOString(),
        },
        'reserved',
      );
    },

    async refund(input) {
      const charge = await store.findById(input.ownerRef, input.chargeId);
      if (charge === null) {
        throw new IntegrationCreditError(
          'CHARGE_NOT_FOUND',
          'No integration charge matches that identifier.',
          404,
        );
      }
      if (charge.state !== 'committed' && charge.state !== 'exempt') {
        throw new IntegrationCreditError(
          'CHARGE_NOT_REFUNDABLE',
          `A ${charge.state} charge cannot be refunded.`,
          409,
        );
      }
      if (charge.walletEntryId !== null && charge.credits > 0) {
        await wallet.refund({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          entryId: charge.walletEntryId,
          reason: input.reason,
          actor: input.actor,
          idempotencyKey: `integration-refund:${charge.id}`,
        });
      }
      return save({ ...charge, state: 'refunded', refundedAt: now().toISOString() }, charge.state);
    },

    async sweep(ref) {
      const open = await store.listOpen(ref.ownerRef, 200);
      const cutoff = now().getTime() - holdTtlSeconds * 1000;
      const released: IntegrationCharge[] = [];
      for (const charge of open) {
        if (ref.workspaceId != null && charge.workspaceId !== ref.workspaceId) continue;
        // A charge whose hold never landed is also abandoned: nothing is holding
        // credit for it, and leaving it open would make the dashboard lie.
        const expired = Date.parse(charge.createdAt) <= cutoff;
        if (!expired && charge.reservationId !== null) continue;
        released.push(
          await service.release({
            ...ref,
            chargeId: charge.id,
            reason:
              charge.reservationId === null
                ? 'Reservation never held credit; closed by the sweep.'
                : 'The reservation passed its hold window without being settled.',
          }),
        );
      }
      return released;
    },

    async summary(ref) {
      const balances = await wallet.overview(await refOf(ref));
      const settings = await settingsOf(ref);
      const month = await monthTotals(ref);
      const open = await store.listOpen(ref.ownerRef, 20);
      return {
        wallet: balances.wallet,
        month,
        openHolds: open
          .filter((charge) => ref.workspaceId == null || charge.workspaceId === ref.workspaceId)
          .map((charge) => ({
            chargeId: charge.id,
            integrationId: charge.integrationId,
            operationId: charge.operationId,
            executionId: charge.executionId,
            estimatedCredits: charge.estimatedCredits,
            createdAt: charge.createdAt,
          })),
        settings,
      };
    },

    async charges(ref, filter) {
      return store.listCharges(ref.ownerRef, {
        limit: filter.limit ?? 50,
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
        ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
        ...(filter.integrationId === undefined ? {} : { integrationId: filter.integrationId }),
        ...(filter.connectorId === undefined ? {} : { connectorId: filter.connectorId }),
        ...(filter.operationId === undefined ? {} : { operationId: filter.operationId }),
        ...(filter.executionId === undefined ? {} : { executionId: filter.executionId }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.state === undefined ? {} : { state: filter.state }),
        ...(filter.billingClass === undefined ? {} : { billingClass: filter.billingClass }),
      });
    },

    async usage(ref, dimension) {
      return store.aggregate(ref.ownerRef, dimension, {
        workspaceId: ref.workspaceId ?? null,
      });
    },

    settings: settingsOf,

    async updateSettings(input) {
      const monthlyLimit =
        input.monthlyLimit === null ? null : assertAmount(input.monthlyLimit, 'The monthly limit');
      const perOperationLimit =
        input.perOperationLimit === null
          ? null
          : assertAmount(input.perOperationLimit, 'The per-operation limit');
      return store.saveSettings({
        ownerRef: input.ownerRef,
        workspaceId: input.workspaceId ?? null,
        monthlyLimit,
        perOperationLimit,
        updatedAt: now().toISOString(),
      });
    },

    async integrity(ref) {
      const walletReport = await wallet.reconcile(await refOf(ref));
      const page = await store.listCharges(ref.ownerRef, {
        limit: 500,
        workspaceId: ref.workspaceId ?? null,
      });
      // A committed charge with credits but no ledger row would mean credit was
      // taken without a record. That is the one inconsistency worth failing on.
      const chargesWithoutEntry = page.charges.filter(
        (charge) =>
          charge.state === 'committed' && charge.credits > 0 && charge.walletEntryId === null,
      ).length;
      return {
        wallet: walletReport,
        chargesWithoutEntry,
        consistent: chargesWithoutEntry === 0,
      };
    },

    /**
     * The one seam the integration runtime uses: hold, run, settle or release.
     *
     * A refusal from the wallet happens before `run` is called, so nothing
     * external happens for work that cannot be paid for. Every outcome ends in a
     * terminal state: success settles against the platform's own measurement
     * (one dispatched operation, and its wall clock); failure releases the hold
     * with the reason.
     */
    async bill(context, run) {
      const estimate = await service.reserve(context);
      const startedAt = Date.now();
      try {
        const result = await run();
        await service.commit({
          ownerRef: context.ownerRef,
          ...(context.workspaceId === undefined || context.workspaceId === null
            ? {}
            : { workspaceId: context.workspaceId }),
          chargeId: estimate.charge.id,
          measurement: {
            // The platform dispatched exactly one operation and timed it. If the
            // connector made more than one outbound request, that is unknown here
            // and is recorded as the lower bound it is.
            requests: 1,
            durationMs: Date.now() - startedAt,
            source: 'platform',
            credential: isUserCredential(context) ? 'user' : 'platform',
          },
        });
        return result;
      } catch (error) {
        await service
          .release({
            ownerRef: context.ownerRef,
            ...(context.workspaceId === undefined || context.workspaceId === null
              ? {}
              : { workspaceId: context.workspaceId }),
            chargeId: estimate.charge.id,
            reason: `The operation failed: ${
              error instanceof Error && error.message.trim() !== ''
                ? error.message.slice(0, 200)
                : 'no reason reported'
            }`,
          })
          .catch(() => undefined);
        throw error;
      }
    },
  };

  return service;
}

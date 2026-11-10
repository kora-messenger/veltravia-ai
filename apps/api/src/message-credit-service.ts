/**
 * Message credits (Step 54).
 *
 * The platform charges per billable interaction. This service is the only place
 * that decides it, and it always decides in the same order:
 *
 *  1. **Estimate.** A policy price for the interaction kind and model, plus what
 *     the caller declared about size. Uncertain estimates are labelled as lower
 *     bounds rather than rounded up into a scary number.
 *  2. **Hold.** Credit is reserved in the Step 53 wallet *before* the work runs,
 *     so a request that cannot be paid for is refused before it costs anything.
 *  3. **Commit.** When the interaction reports usage, the measured charge is
 *     posted to the ledger and the unused part of the hold goes back.
 *  4. **Release.** A failed, cancelled or abandoned interaction returns its hold.
 *
 * Two invariants make the whole thing safe to retry: a charge is written once
 * per idempotency key, and money only moves through the wallet ledger, which has
 * its own idempotency and reservation guarantees.
 */

import {
  type ChargeEstimate,
  type ChargeFilter,
  type MessageCharge,
  type MessageChargeDraft,
  type MessageCreditStore,
  type SpendingSettings,
  type UsageDimension,
  type UsageGroup,
  type UsageMeasurement,
  computeCharge,
  creditRound,
  estimateCharge,
  isMessageCreditError,
  MessageCreditError,
  planCharging,
  policyFor,
  parseChargingCatalog,
  type ChargingCatalog,
  type InteractionKind,
} from '@veltravia/message-credits-core';

import { InMemoryMessageCreditStore } from '@veltravia/message-credits-core';

import type { WalletService } from './wallet-service.js';

const DEFAULT_HOLD_TTL_SECONDS = 900;

export interface WalletRef {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
}

export interface ChargeContext extends WalletRef {
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly runId?: string | null;
  readonly taskId?: string | null;
  /** The charge this one was delegated from, when it was. */
  readonly parentChargeId?: string | null;
  readonly usageOperationKey?: string | null;
  readonly kind: InteractionKind;
  readonly modelId?: string | null;
  readonly providerId?: string | null;
  readonly idempotencyKey: string;
  readonly byok?: boolean;
  readonly ttlSeconds?: number;
}

export interface ReserveResult {
  readonly charge: MessageCharge;
  readonly created: boolean;
  readonly estimate: ChargeEstimate;
  readonly reservationId: string | null;
  readonly walletAvailable: number;
}

export interface CommitResult {
  readonly charge: MessageCharge;
  readonly credits: number;
  readonly released: number;
  /** Credits the charge needed beyond the hold, and whether credit covered it. */
  readonly aboveHold: number;
  readonly aboveHoldCovered: boolean;
}

export interface MonthUsage {
  readonly charges: number;
  readonly credits: number;
  readonly refunded: number;
  /** Charges still holding credit, and the credit they are holding. */
  readonly open: number;
  readonly openCredits: number;
  /**
   * Tokens behind the settled charges. Cached input is billed at the cache rate,
   * so it is counted apart from the rest of the input; the two always add up to
   * the input total that was measured.
   */
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly uncached: number;
  };
  readonly byKind: readonly UsageGroup[];
}

export interface MessageCreditService {
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;
  readonly catalog: ChargingCatalog;
  planOf(ownerRef: string): Promise<string>;
  catalogView(): unknown;
  summary(ref: WalletRef): Promise<unknown>;
  estimate(input: ChargeContext & { readonly maxOutputTokens?: number | null }): Promise<{
    readonly estimate: ChargeEstimate;
    readonly policyId: string | null;
    readonly planId: string;
    readonly walletAvailable: number;
    readonly affordable: boolean;
    readonly shortfall: number;
  }>;
  reserve(input: ChargeContext): Promise<ReserveResult>;
  commit(
    input: WalletRef & {
      readonly chargeId?: string;
      readonly reservationId?: string;
      readonly measurement: UsageMeasurement;
    },
  ): Promise<CommitResult>;
  release(
    input: WalletRef & {
      readonly chargeId?: string;
      readonly reservationId?: string;
      readonly reason: string;
    },
  ): Promise<MessageCharge>;
  attachRun(
    input: WalletRef & { readonly chargeId: string; readonly runId: string },
  ): Promise<MessageCharge>;
  commitForRun(
    input: WalletRef & { readonly runId: string; readonly measurement: UsageMeasurement },
  ): Promise<CommitResult | null>;
  releaseForRun(
    input: WalletRef & { readonly runId: string; readonly reason: string },
  ): Promise<number>;
  refund(
    input: WalletRef & {
      readonly chargeId: string;
      readonly reason: string;
      readonly actor: string;
    },
  ): Promise<MessageCharge>;
  sweep(input: WalletRef): Promise<readonly MessageCharge[]>;
  charges(
    ref: WalletRef,
    filter: Omit<ChargeFilter, 'limit'> & { readonly limit?: number },
  ): Promise<unknown>;
  usage(ref: WalletRef, dimension: UsageDimension): Promise<readonly UsageGroup[]>;
  settings(ref: WalletRef): Promise<SpendingSettings>;
  updateSettings(
    input: WalletRef & {
      readonly monthlyLimit: number | null;
      readonly perRequestLimit: number | null;
    },
  ): Promise<SpendingSettings>;
  integrity(input: WalletRef): Promise<{
    readonly wallet: unknown;
    readonly chargesWithoutEntry: number;
    readonly consistent: boolean;
  }>;
}

export interface MessageCreditServiceOptions {
  readonly store?: MessageCreditStore | undefined;
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

export function createMessageCreditService(
  options: MessageCreditServiceOptions,
): MessageCreditService {
  const env = options.env ?? process.env;
  const store = options.store ?? new InMemoryMessageCreditStore();
  const wallet: WalletService = options.wallet;
  const now = options.now ?? (() => new Date());
  const catalog = parseChargingCatalog(env['VELTRAVIA_MESSAGE_CHARGES']);
  const holdTtlSeconds = readPositiveInt(
    env,
    'VELTRAVIA_MESSAGE_HOLD_TTL_SECONDS',
    DEFAULT_HOLD_TTL_SECONDS,
  );
  let seq = 0;
  const newId = (prefix: string): string => `${prefix}_${now().getTime().toString(36)}_${++seq}`;

  /**
   * Which purse a charge draws from.
   *
   * A workspace wallet is a real purse once somebody funds it - the operator
   * credit route can name a workspace - and from then on it pays its own way.
   * A workspace nobody has funded is not a purse: charging its empty balance
   * refused every coding run and worker on accounts that held credit, so an
   * unfunded workspace defers to the account holder's own wallet.
   *
   * The decision sticks because a hold moves reserved above zero: while the
   * charge is open, the purse it was taken from reads as funded, so settle and
   * release resolve the same wallet.
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
      throw new MessageCreditError('INVALID_AMOUNT', `${label} must be a positive number.`, 400);
    }
    return creditRound(value);
  };

  const policyForOwner = async (
    ownerRef: string,
    kind: InteractionKind,
    modelId: string | null,
  ) => {
    const planId = await options.planOf(ownerRef);
    const plan = planCharging(catalog, planId);
    return { planId, plan, policy: policyFor(plan, kind, modelId) };
  };

  const draftCharge = (input: ChargeContext, estimate: ChargeEstimate): MessageChargeDraft => ({
    ownerRef: input.ownerRef,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    runId: input.runId ?? null,
    taskId: input.taskId ?? null,
    parentChargeId: input.parentChargeId ?? null,
    usageOperationKey: input.usageOperationKey ?? null,
    kind: input.kind,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    estimatedCredits: estimate.credits,
    policyId: estimate.policyId ?? 'none',
    byok: input.byok === true,
    idempotencyKey: input.idempotencyKey,
  });

  const materialise = (
    draft: MessageChargeDraft,
    state: MessageCharge['state'],
  ): MessageCharge => ({
    id: newId('mch'),
    ownerRef: draft.ownerRef,
    workspaceId: draft.workspaceId ?? null,
    projectId: draft.projectId ?? null,
    conversationId: draft.conversationId ?? null,
    runId: draft.runId ?? null,
    taskId: draft.taskId ?? null,
    parentChargeId: draft.parentChargeId ?? null,
    usageOperationKey: draft.usageOperationKey ?? null,
    kind: draft.kind,
    modelId: draft.modelId ?? null,
    providerId: draft.providerId ?? null,
    byok: draft.byok === true,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    durationMs: null,
    toolCalls: null,
    credits: 0,
    estimatedCredits: draft.estimatedCredits,
    state,
    basis: state === 'exempt' ? 'exempt' : 'flat',
    policyId: draft.policyId,
    limitations: [],
    measurementSource: null,
    cachedSavings: null,
    idempotencyKey: draft.idempotencyKey,
    reservationId: null,
    walletEntryId: null,
    failureReason: null,
    createdAt: now().toISOString(),
    settledAt: state === 'exempt' ? now().toISOString() : null,
    refundedAt: null,
  });

  const save = async (
    charge: MessageCharge,
    expected: MessageCharge['state'],
  ): Promise<MessageCharge> => {
    const saved = await store.saveCharge(charge, expected);
    if (!saved) {
      // Somebody else settled this charge first; their state is the truth.
      const current = await store.findById(charge.ownerRef, charge.id);
      if (current !== null) return current;
      throw new MessageCreditError('CHARGE_NOT_FOUND', 'That charge no longer exists.', 404);
    }
    return charge;
  };

  const settingsOf = async (ref: WalletRef): Promise<SpendingSettings> =>
    (await store.readSettings(ref.ownerRef, ref.workspaceId ?? null)) ?? {
      ownerRef: ref.ownerRef,
      workspaceId: ref.workspaceId ?? null,
      monthlyLimit: null,
      perRequestLimit: null,
      updatedAt: now().toISOString(),
    };

  const monthTotals = async (ref: WalletRef): Promise<MonthUsage> => {
    const since = monthStart(now());
    const page = await store.listCharges(ref.ownerRef, {
      limit: 500,
      workspaceId: ref.workspaceId ?? null,
    });
    const inMonth = page.charges.filter((charge) => charge.createdAt >= since);
    const committed = inMonth.filter(
      (charge) => charge.state === 'committed' || charge.state === 'exempt',
    );
    const refunded = inMonth.filter((charge) => charge.state === 'refunded');
    const open = inMonth.filter((charge) => charge.state === 'reserved');
    const sum = (
      rows: readonly (typeof committed)[number][],
      pick: (row: (typeof committed)[number]) => number,
    ) => rows.reduce((total, row) => total + pick(row), 0);
    const counted = committed.filter((charge) => charge.byok !== true);
    const input = sum(counted, (charge) => charge.inputTokens ?? 0);
    const cached = Math.min(
      sum(counted, (charge) => charge.cachedTokens ?? 0),
      input,
    );
    return {
      charges: committed.length,
      credits: creditRound(committed.reduce((total, charge) => total + charge.credits, 0)),
      refunded: creditRound(refunded.reduce((total, charge) => total + charge.credits, 0)),
      open: open.length,
      openCredits: creditRound(
        open.reduce((total, charge) => total + (charge.estimatedCredits ?? charge.credits ?? 0), 0),
      ),
      tokens: {
        input,
        output: sum(counted, (charge) => charge.outputTokens ?? 0),
        cached,
        uncached: Math.max(0, input - cached),
      },
      byKind: await store.aggregate(ref.ownerRef, 'kind', {
        since,
        workspaceId: ref.workspaceId ?? null,
      }),
    };
  };

  const service: MessageCreditService = {
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
        plans: catalog.plans.map((plan) => ({
          planId: plan.planId,
          label: plan.label,
          billable: plan.billable,
          policies: plan.policies.map((policy) => ({
            id: policy.id,
            label: policy.label,
            kind: policy.kind,
            flatCredits: policy.flat === null ? null : policy.flat.credits,
            per1kInput: policy.tokens?.per1kInput ?? null,
            per1kOutput: policy.tokens?.per1kOutput ?? null,
            per1kCached: policy.tokens?.per1kCached ?? null,
            perToolCall: policy.tokens?.perToolCall ?? null,
            chargeByok: policy.chargeByok,
          })),
        })),
      };
    },

    async summary(ref) {
      const balances = await wallet.overview(await refOf(ref));
      const settings = await settingsOf(ref);
      const month = await monthTotals(ref);
      const open = await store.listOpen(ref.ownerRef, 20);
      return {
        wallet: balances.wallet,
        openReservations: open
          .filter((charge) => ref.workspaceId == null || charge.workspaceId === ref.workspaceId)
          .map((charge) => ({
            chargeId: charge.id,
            kind: charge.kind,
            estimatedCredits: charge.estimatedCredits,
            conversationId: charge.conversationId,
            createdAt: charge.createdAt,
          })),
        month,
        settings,
      };
    },

    async estimate(input) {
      const { planId, policy } = await policyForOwner(
        input.ownerRef,
        input.kind,
        input.modelId ?? null,
      );
      const estimate = estimateCharge({
        policy,
        maxOutputTokens: input.maxOutputTokens ?? null,
        ...(input.byok === true ? { byok: true } : {}),
      });
      const balances = await wallet.overview(await refOf(input));
      const available = balances.wallet.available;
      const affordable = estimate.exempt || available >= estimate.credits;
      return {
        estimate,
        policyId: policy?.id ?? null,
        planId,
        walletAvailable: available,
        affordable,
        shortfall: affordable ? 0 : creditRound(estimate.credits - available),
      };
    },

    async reserve(input) {
      const existing = await store.findByKey(input.ownerRef, input.idempotencyKey);
      if (existing !== null) {
        const balances = await wallet.overview(await refOf(input));
        return {
          charge: existing,
          created: false,
          estimate: {
            credits: existing.estimatedCredits,
            basis: existing.basis,
            lowerBound: false,
            exempt: existing.state === 'exempt',
            policyId: existing.policyId,
          },
          reservationId: existing.reservationId,
          walletAvailable: balances.wallet.available,
        };
      }

      const { plan, policy } = await policyForOwner(
        input.ownerRef,
        input.kind,
        input.modelId ?? null,
      );
      const estimate = estimateCharge({
        policy,
        ...(input.byok === true ? { byok: true } : {}),
      });
      const settings = await settingsOf(input);

      if (settings.perRequestLimit !== null && estimate.credits > settings.perRequestLimit) {
        throw new MessageCreditError(
          'REQUEST_LIMIT_EXCEEDED',
          `This request is estimated at ${estimate.credits} credits, above your per-request limit of ${settings.perRequestLimit}.`,
          400,
          { estimated: estimate.credits, limit: settings.perRequestLimit },
        );
      }

      const month = await monthTotals(input);
      if (
        settings.monthlyLimit !== null &&
        month.credits + estimate.credits > settings.monthlyLimit
      ) {
        throw new MessageCreditError(
          'MONTHLY_LIMIT_REACHED',
          `Your monthly message-credit limit of ${settings.monthlyLimit} would be exceeded.`,
          402,
          { spent: month.credits, limit: settings.monthlyLimit, estimated: estimate.credits },
        );
      }

      if (!plan.billable || estimate.exempt || estimate.credits === 0) {
        const { charge } = await store.insertCharge(
          materialise(draftCharge(input, estimate), 'exempt'),
        );
        const balances = await wallet.overview(await refOf(input));
        return {
          charge,
          created: true,
          estimate,
          reservationId: null,
          walletAvailable: balances.wallet.available,
        };
      }

      // The row is written before the hold so a crash between the two leaves an
      // auditable "reserved with no hold" row the sweep can close, rather than a
      // hold nobody can explain.
      const draft = draftCharge(input, estimate);
      const { charge, created } = await store.insertCharge(materialise(draft, 'reserved'));
      if (!created) {
        const balances = await wallet.overview(await refOf(input));
        return {
          charge,
          created: false,
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
          operationKey: `msg:${charge.id}`,
          reason: `Message credit hold for a ${input.kind.replace('.', ' ')}.`,
          actor: 'message-credits',
        });
      } catch (error) {
        await save(
          {
            ...charge,
            state: 'released',
            failureReason: isMessageCreditError(error) ? error.code : 'reservation-refused',
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
        throw new MessageCreditError('CHARGE_NOT_FOUND', 'No charge matches that identifier.', 404);
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

      const { plan, policy } = await policyForOwner(input.ownerRef, charge.kind, charge.modelId);
      const computed = computeCharge({
        policy,
        planBillable: plan.billable,
        // The hold knows whether the caller brought their own key; the provider's
        // token report does not, and must not be able to change that.
        measurement: { ...input.measurement, byok: charge.byok },
      });

      const reservationId = charge.reservationId;
      let walletEntryId: string | null = charge.walletEntryId;
      let aboveHold = 0;
      let aboveHoldCovered = true;

      if (reservationId !== null && computed.credits > 0) {
        const result = await wallet.commit({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          reservationId,
          amount: computed.credits,
          reason: `Message charge for ${charge.kind.replace('.', ' ')} ${charge.id}.`,
          actor: 'message-credits',
        });
        walletEntryId = result.entry.id;
        aboveHold = creditRound(Math.max(0, computed.credits - charge.estimatedCredits));
        if (aboveHold > 0) {
          // The measurement came in above the hold. Take the difference as a
          // second, separately keyed charge; if the wallet cannot cover it the
          // charge is recorded as under-recovered rather than overdrawn.
          try {
            const extra = await wallet.adjust({
              ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
              amount: aboveHold,
              direction: 'debit',
              actor: 'message-credits',
              reason: `Message charge above hold for ${charge.id}.`,
              idempotencyKey: `msg-over:${charge.id}`,
            });
            walletEntryId = extra.entry.id;
          } catch (error) {
            aboveHoldCovered = false;
            if (!isMessageCreditError(error) && (error as { code?: string }).code !== undefined) {
              // Anything else is still a refusal to charge, never a crash.
            }
          }
        }
      } else if (reservationId !== null) {
        // Nothing is owed: give the whole hold back rather than posting a zero.
        await wallet.release({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          reservationId,
          reason: 'The interaction used no chargeable credit.',
          actor: 'message-credits',
        });
      }

      const settled: MessageCharge = {
        ...charge,
        state: computed.exempt ? 'exempt' : 'committed',
        basis: computed.basis,
        credits: computed.credits,
        inputTokens: input.measurement.inputTokens ?? null,
        outputTokens: input.measurement.outputTokens ?? null,
        cachedTokens: input.measurement.cachedTokens ?? null,
        durationMs: input.measurement.durationMs ?? null,
        toolCalls: input.measurement.toolCalls ?? null,
        modelId: input.measurement.modelId ?? charge.modelId,
        providerId: input.measurement.providerId ?? charge.providerId,
        limitations: computed.limitations,
        measurementSource:
          input.measurement.source ??
          (input.measurement.inputTokens === undefined || input.measurement.inputTokens === null
            ? 'unavailable'
            : 'provider'),
        cachedSavings: computed.cachedSavings,
        walletEntryId,
        failureReason: aboveHoldCovered ? null : 'measurement-above-hold-uncovered',
        settledAt: now().toISOString(),
      };
      return {
        charge: await save(settled, 'reserved'),
        credits: computed.credits,
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
        throw new MessageCreditError('CHARGE_NOT_FOUND', 'No charge matches that identifier.', 404);
      }
      if (charge.state !== 'reserved') return charge;
      if (charge.reservationId !== null) {
        await wallet.release({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          reservationId: charge.reservationId,
          reason: input.reason,
          actor: 'message-credits',
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

    async attachRun(input) {
      const charge = await store.findById(input.ownerRef, input.chargeId);
      if (charge === null) {
        throw new MessageCreditError('CHARGE_NOT_FOUND', 'No charge matches that identifier.', 404);
      }
      return save({ ...charge, runId: input.runId }, charge.state);
    },

    async commitForRun(input) {
      const page = await store.listCharges(input.ownerRef, { limit: 200 });
      const charge = page.charges.find(
        (row) => row.runId === input.runId && row.state === 'reserved',
      );
      if (charge === undefined) return null;
      return service.commit({
        ownerRef: input.ownerRef,
        ...(charge.workspaceId === null ? {} : { workspaceId: charge.workspaceId }),
        chargeId: charge.id,
        measurement: input.measurement,
      });
    },

    async releaseForRun(input) {
      const page = await store.listCharges(input.ownerRef, { limit: 200 });
      const open = page.charges.filter(
        (row) => row.runId === input.runId && row.state === 'reserved',
      );
      for (const charge of open) {
        await service.release({
          ownerRef: input.ownerRef,
          ...(charge.workspaceId === null ? {} : { workspaceId: charge.workspaceId }),
          chargeId: charge.id,
          reason: input.reason,
        });
      }
      return open.length;
    },

    async refund(input) {
      const charge = await store.findById(input.ownerRef, input.chargeId);
      if (charge === null) {
        throw new MessageCreditError('CHARGE_NOT_FOUND', 'No charge matches that identifier.', 404);
      }
      if (charge.state === 'refunded') return charge;
      if (charge.state !== 'committed' && charge.state !== 'exempt') {
        throw new MessageCreditError(
          'CHARGE_NOT_REFUNDABLE',
          `A charge in state "${charge.state}" has nothing to refund.`,
          409,
        );
      }
      if (charge.walletEntryId !== null && charge.credits > 0) {
        await wallet.refund({
          ...(await refOf({ ownerRef: input.ownerRef, workspaceId: charge.workspaceId })),
          entryId: charge.walletEntryId,
          reason: input.reason,
          actor: input.actor,
          idempotencyKey: `msg-refund:${charge.id}`,
        });
      }
      return save({ ...charge, state: 'refunded', refundedAt: now().toISOString() }, charge.state);
    },

    async sweep(ref) {
      const open = await store.listOpen(ref.ownerRef, 200);
      const cutoff = now().getTime() - holdTtlSeconds * 1000;
      const released: MessageCharge[] = [];
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

    async charges(ref, filter) {
      const page = await store.listCharges(ref.ownerRef, {
        limit: filter.limit ?? 50,
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
        ...(filter.conversationId === undefined ? {} : { conversationId: filter.conversationId }),
        ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
        ...(filter.runId === undefined ? {} : { runId: filter.runId }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.state === undefined ? {} : { state: filter.state }),
      });
      return page;
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
      const perRequestLimit =
        input.perRequestLimit === null
          ? null
          : assertAmount(input.perRequestLimit, 'The per-request limit');
      return store.saveSettings({
        ownerRef: input.ownerRef,
        workspaceId: input.workspaceId ?? null,
        monthlyLimit,
        perRequestLimit,
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
  };

  return service;
}

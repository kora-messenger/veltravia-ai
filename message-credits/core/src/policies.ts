/**
 * What an interaction costs in credits (Step 54).
 *
 * Every number here is a **configurable default**, not a market price. They are
 * labelled as such everywhere they surface, they can be replaced wholesale from
 * the environment, and nothing in this file knows or cares what a provider
 * charges in dollars: credits price this platform's work, provider invoices are
 * a separate column (Step 52) and a separate bill (the caller's own key).
 *
 * Two rate shapes exist because two kinds of work exist:
 *
 *  - a flat price per interaction, for work whose size is decided by the
 *    platform (one chat turn, one agent run);
 *  - a per-token price, for work whose size is decided by the model.
 *
 * A policy may use both. A policy that uses neither charges nothing, and says so
 * with `basis: 'unmeasured'` when there was nothing to measure either.
 */

import type { InteractionKind } from './types.js';

export interface FlatRate {
  readonly credits: number;
}

export interface TokenRates {
  /** Credits per 1,000 input tokens. */
  readonly per1kInput: number;
  /** Credits per 1,000 output tokens. */
  readonly per1kOutput: number;
  /** Credits per 1,000 tokens served from the provider's cache, when reported. */
  readonly per1kCached: number;
  /** Credits per tool call the platform executed on the caller's behalf. */
  readonly perToolCall: number;
}

export interface ChargingPolicy {
  readonly id: string;
  readonly label: string;
  readonly kind: InteractionKind;
  /** Null when this interaction has no flat component. */
  readonly flat: FlatRate | null;
  /** Null when this interaction is not priced by tokens. */
  readonly tokens: TokenRates | null;
  /**
   * Whether a request made with the caller's own provider key is charged here.
   * False by default: the provider bill belongs to the key holder, and Step 52
   * already records those tokens without ever deducting them.
   */
  readonly chargeByok: boolean;
}

export interface PlanCharging {
  readonly planId: string;
  readonly label: string;
  /** When false, nothing on this plan is charged and every charge is `exempt`. */
  readonly billable: boolean;
  readonly policies: readonly ChargingPolicy[];
  /** Per-model overrides, keyed by model id prefix (e.g. `openai/gpt-4o`). */
  readonly modelOverrides?: readonly {
    readonly modelPrefix: string;
    readonly policy: ChargingPolicy;
  }[];
}

export interface ChargingCatalog {
  /** Bumped by hand whenever the defaults change, so charges stay explainable. */
  readonly version: string;
  /** Always true for the shipped table: these are defaults, not market prices. */
  readonly defaultsOnly: boolean;
  readonly plans: readonly PlanCharging[];
  readonly currency: 'credits';
}

/**
 * The shipped default table.
 *
 * Read the numbers as placeholders a deployment can replace, not as a price
 * list: one chat turn, one coding run, one agent step, one background task. The
 * token rates exist so a long answer costs more than a short one; they are small
 * because the flat part already covers the interaction.
 */
export function defaultChargingCatalog(): ChargingCatalog {
  const standard = (
    kind: InteractionKind,
    id: string,
    label: string,
    flat: number,
    tokens: TokenRates | null,
    chargeByok = false,
  ): ChargingPolicy => ({ id, label, kind, flat: { credits: flat }, tokens, chargeByok });

  const chatTokens: TokenRates = {
    per1kInput: 0.25,
    per1kOutput: 0.75,
    per1kCached: 0.05,
    perToolCall: 0.1,
  };

  return {
    version: 'message-credits/2026-11-default',
    defaultsOnly: true,
    currency: 'credits',
    plans: [
      {
        planId: 'development',
        label: 'Development (charges recorded, never enforced)',
        billable: false,
        policies: [
          standard('chat.message', 'dev.chat', 'Chat turn', 0, chatTokens),
          standard('coding.run', 'dev.coding', 'Coding run', 0, chatTokens),
          standard('agent.execution', 'dev.agent', 'Agent run', 0, chatTokens),
          standard('background.task', 'dev.background', 'Background task', 0, null),
        ],
      },
      {
        planId: 'paid',
        label: 'Paid',
        billable: true,
        policies: [
          // `chargeByok: true` means the platform's flat charge applies even when
          // the caller supplied the provider key. The token part never does.
          standard('chat.message', 'paid.chat', 'Chat turn', 1, chatTokens, true),
          standard('chat.assistant', 'paid.chat-assistant', 'Assistant reply', 1, chatTokens, true),
          standard('coding.run', 'paid.coding', 'Coding run', 5, chatTokens, true),
          standard('agent.execution', 'paid.agent', 'Agent run', 3, chatTokens, true),
          standard('tool.call', 'paid.tool', 'Tool call', 0.2, null, true),
          standard('background.task', 'paid.background', 'Background task', 2, null, true),
        ],
        modelOverrides: [
          {
            modelPrefix: 'anthropic/claude',
            policy: {
              id: 'paid.chat.reasoning',
              label: 'Chat turn (large model)',
              kind: 'chat.message',
              flat: { credits: 2 },
              tokens: { per1kInput: 0.5, per1kOutput: 1.5, per1kCached: 0.1, perToolCall: 0.2 },
              chargeByok: true,
            },
          },
        ],
      },
    ],
  };
}

const positive = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Reads a deployment's own table: `VELTRAVIA_MESSAGE_CHARGES` as JSON in the
 * shape of `ChargingCatalog`. A malformed table is refused rather than
 * half-applied, because a half-applied price table is a billing incident.
 */
export function parseChargingCatalog(raw: string | undefined): ChargingCatalog {
  const fallback = defaultChargingCatalog();
  if (raw === undefined || raw.trim() === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'VELTRAVIA_MESSAGE_CHARGES is not valid JSON; refusing to guess a price table.',
    );
  }
  const table = parsed as Partial<ChargingCatalog>;
  if (table === null || typeof table !== 'object' || !Array.isArray(table.plans)) {
    throw new Error('VELTRAVIA_MESSAGE_CHARGES must be an object with a plans array.');
  }
  const plans: PlanCharging[] = table.plans.map((plan) => {
    const candidate = plan as unknown as PlanCharging;
    const policies = Array.isArray(candidate.policies) ? candidate.policies : [];
    return {
      planId: String(candidate.planId),
      label: String(candidate.label ?? candidate.planId),
      billable: candidate.billable !== false,
      policies: policies.map((policy) => ({
        id: String(policy.id),
        label: String(policy.label ?? policy.id),
        kind: policy.kind,
        flat:
          policy.flat === null || policy.flat === undefined
            ? null
            : { credits: positive(policy.flat.credits, 0) },
        tokens:
          policy.tokens === null || policy.tokens === undefined
            ? null
            : {
                per1kInput: positive(policy.tokens.per1kInput, 0),
                per1kOutput: positive(policy.tokens.per1kOutput, 0),
                per1kCached: positive(policy.tokens.per1kCached, 0),
                perToolCall: positive(policy.tokens.perToolCall, 0),
              },
        chargeByok: policy.chargeByok === true,
      })),
      ...(Array.isArray(candidate.modelOverrides)
        ? {
            modelOverrides: candidate.modelOverrides.map((override) => ({
              modelPrefix: String(override.modelPrefix),
              policy: override.policy,
            })),
          }
        : {}),
    };
  });
  return {
    version: String(table.version ?? 'custom'),
    defaultsOnly: false,
    currency: 'credits',
    plans,
  };
}

/** The plan's row, falling back to the development row rather than inventing one. */
export function planCharging(catalog: ChargingCatalog, planId: string): PlanCharging {
  return (
    catalog.plans.find((plan) => plan.planId === planId) ??
    catalog.plans.find((plan) => plan.planId === 'development') ?? {
      planId,
      label: planId,
      billable: false,
      policies: [],
    }
  );
}

/**
 * The policy that applies to one interaction. A model override wins only when it
 * covers the same interaction kind, so a chat override can never price a coding
 * run.
 */
export function policyFor(
  plan: PlanCharging,
  kind: InteractionKind,
  modelId: string | null,
): ChargingPolicy | null {
  if (modelId !== null && plan.modelOverrides !== undefined) {
    const override = plan.modelOverrides.find(
      (candidate) =>
        candidate.policy.kind === kind && modelId.toLowerCase().startsWith(candidate.modelPrefix),
    );
    if (override !== undefined) return override.policy;
  }
  return plan.policies.find((policy) => policy.kind === kind) ?? null;
}

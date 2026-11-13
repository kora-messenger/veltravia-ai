/**
 * Spending limits (Step 59).
 *
 * This is the only place that answers "may this billable operation start?" for
 * credit limits. It owns no ledger, no price list and no usage table:
 *
 *  - **configuration** comes from `spending_limit_policies`, one row per scope,
 *    validated against both fixed ceilings and any platform maximum;
 *  - **usage** is read from the two charge lanes that already record it, holds
 *    included, so reserved credit counts against the allowance;
 *  - **the decision** is `evaluateSpending`, a pure function in the core package;
 *  - **what happened** - a threshold crossed, a limit reached, an operation
 *    refused, a policy changed - is written once per dedupe key, so fifty
 *    concurrent requests crossing 80% produce one warning and not fifty.
 *
 * It is deliberately separate from the older per-lane settings: Step 54's
 * monthly limit and Step 56's integration ceiling still exist and still refuse
 * their own work. A Step 59 rule is the account-wide control above them, and the
 * two compose by taking the tightest refusal, never by one overriding the other.
 */

import {
  DEFAULT_PLATFORM_LIMITS,
  InMemorySpendingLimitStore,
  SpendingLimitError,
  creditRound,
  evaluateSpending,
  normalisePolicy,
  platformDefaults,
  windowsFor,
  type AppliedPolicy,
  type LimitAuditRecord,
  type LimitEvent,
  type LimitEventKind,
  type LimitScope,
  type LimitTarget,
  type PlatformLimitPolicy,
  type PolicyDraft,
  type SpendCategory,
  type SpendDecision,
  type SpendSample,
  type SpendWindow,
  type SpendingLimitPolicy,
  type SpendingLimitStore,
} from '@veltravia/spending-limits-core';

import type { IntegrationCreditService } from './integration-credit-service.js';
import type { MessageCreditService } from './message-credit-service.js';

/**
 * The Step 58 category each charge kind belongs to. This mapping is the only
 * place the two vocabularies meet, so a limit and the usage page name the same
 * spend the same way.
 */
const MESSAGE_KIND_CATEGORY: Readonly<Record<string, SpendCategory>> = {
  'chat.message': 'ai_messages',
  'chat.assistant': 'ai_messages',
  'coding.run': 'coding',
  'agent.execution': 'agents',
  'agent.run': 'agents',
  'reasoning.run': 'reasoning',
  'tool.call': 'tools',
  'background.task': 'background',
};

export interface SpendRef {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
}

export interface AuthorizeInput extends SpendRef {
  readonly category: SpendCategory;
  /** Credits the operation is estimated to need. Zero still evaluates warnings. */
  readonly requested: number;
  /** What the work is, for the refusal message and the event. */
  readonly activity?: string;
  readonly actor?: string;
  /** Skip the event write when the caller only wants a number (a preview). */
  readonly record?: boolean;
}

export interface SavePolicyInput {
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly rules: readonly unknown[];
  readonly perOperationLimit?: number | null;
  readonly maxReservedCredits?: number | null;
  /** The version the caller saw. `null` creates. */
  readonly expectedVersion: number | null;
  readonly actor: string;
  readonly reason: string;
}

export interface ResetPolicyInput {
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly expectedVersion: number;
  readonly actor: string;
  readonly reason: string;
}

/** One limit with its live numbers, as a screen shows it. */
export interface LimitView {
  readonly ruleId: string;
  readonly scope: LimitScope;
  readonly target: LimitTarget;
  readonly period: string;
  readonly mode: string;
  readonly limit: number;
  readonly committed: number;
  readonly reserved: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly ratio: number;
  readonly state: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly source: string;
}

export interface CategoryUsageView {
  readonly category: SpendCategory;
  readonly label: string;
  readonly committed: number;
  readonly reserved: number;
  readonly refunded: number;
  readonly charges: number;
  /**
   * False for a category the platform records in quantity but does not price in
   * credits. Saying "0 credits" for unmeasured infrastructure would be a claim.
   */
  readonly priced: boolean;
}

export interface SpendingOverview {
  readonly scopes: readonly {
    readonly scope: LimitScope;
    readonly workspaceId: string | null;
    readonly projectId: string | null;
    readonly policy: SpendingLimitPolicy | null;
    readonly inherited: boolean;
  }[];
  readonly limits: readonly LimitView[];
  /** Reset times for the calendar windows, so a screen can say "resets at". */
  readonly windows: readonly {
    readonly period: string;
    readonly start: string;
    readonly end: string;
  }[];
  readonly usage: {
    readonly today: readonly CategoryUsageView[];
    readonly week: readonly CategoryUsageView[];
    readonly month: readonly CategoryUsageView[];
  };
  readonly heldCredits: number;
  readonly perOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
  readonly enforcement: 'enforced' | 'disabled' | 'unconfigured';
  readonly platform: PlatformLimitPolicy;
  readonly wallet: {
    readonly available: number;
    readonly reserved: number;
    readonly spent: number;
  } | null;
  readonly events: readonly LimitViewEvent[];
  readonly generatedAt: string;
}

export interface LimitViewEvent {
  readonly id: string;
  readonly kind: LimitEventKind;
  readonly scope: LimitScope;
  readonly ruleId: string | null;
  readonly message: string;
  readonly occurredAt: string;
}

export interface SpendingLimitService {
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;

  policy(key: SpendRef & { readonly scope: LimitScope }): Promise<SpendingLimitPolicy | null>;
  policies(ownerRef: string): Promise<readonly SpendingLimitPolicy[]>;
  savePolicy(input: SavePolicyInput): Promise<SpendingLimitPolicy>;
  resetPolicy(input: ResetPolicyInput): Promise<void>;
  platform(): Promise<PlatformLimitPolicy>;
  savePlatform(
    input: PlatformLimitPolicy & { readonly actor: string; readonly reason: string },
  ): Promise<PlatformLimitPolicy>;

  overview(ref: SpendRef): Promise<SpendingOverview>;
  events(
    ownerRef: string,
    filter: { readonly kind?: LimitEventKind; readonly since?: string; readonly limit: number },
  ): Promise<readonly LimitEvent[]>;
  audit(ownerRef: string, limit: number): Promise<readonly LimitAuditRecord[]>;

  /** The one enforcement call. Every billable path goes through it. */
  authorize(input: AuthorizeInput): Promise<SpendDecision>;
  /** A decision without events; for a UI preview or a dry run. */
  preview(input: AuthorizeInput): Promise<SpendDecision>;
  /** Credit held right now, for a header or a ceiling check. */
  heldCredits(ownerRef: string): Promise<number>;
}

export interface SpendingLimitServiceOptions {
  readonly store?: SpendingLimitStore | undefined;
  readonly messageCredits: Pick<MessageCreditService, 'limitUsage' | 'heldCredits'>;
  readonly integrationCredits: Pick<IntegrationCreditService, 'limitUsage' | 'heldCredits'>;
  readonly wallet?: {
    overview(ref: SpendRef): Promise<{
      readonly wallet: {
        readonly available: number;
        readonly reserved: number;
        readonly spent: number;
      };
    }>;
  };
  /** Notified once per new warning or refusal. Never called twice for a key. */
  readonly onEvent?: ((event: LimitEvent) => void) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
}

const CATEGORY_LABEL: Readonly<Record<SpendCategory, string>> = {
  ai_messages: 'Chat and messages',
  coding: 'Coding agent',
  agents: 'Agents and delegation',
  reasoning: 'Reasoning',
  tools: 'Tool calls',
  background: 'Background work',
  integrations: 'Integrations',
  infrastructure: 'Infrastructure',
};

const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const emptyCategories = (): Record<SpendCategory, SpendSample> => ({
  ai_messages: { category: 'ai_messages', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  coding: { category: 'coding', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  agents: { category: 'agents', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  reasoning: { category: 'reasoning', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  tools: { category: 'tools', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  background: { category: 'background', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  integrations: { category: 'integrations', committed: 0, reserved: 0, refunded: 0, charges: 0 },
  infrastructure: {
    category: 'infrastructure',
    committed: 0,
    reserved: 0,
    refunded: 0,
    charges: 0,
  },
});

/** Windows the overview shows: today, this week, this month. */
function calendarWindows(now: Date): readonly SpendWindow[] {
  return windowsFor(
    [
      {
        scope: 'user',
        workspaceId: null,
        projectId: null,
        source: 'owner',
        perOperationLimit: null,
        maxReservedCredits: null,
        rules: [
          {
            id: 'view-daily',
            target: 'all',
            period: 'daily',
            limit: 0,
            mode: 'soft',
            periodDays: null,
            periodAnchor: null,
            warnAt: [],
          },
          {
            id: 'view-weekly',
            target: 'all',
            period: 'weekly',
            limit: 0,
            mode: 'soft',
            periodDays: null,
            periodAnchor: null,
            warnAt: [],
          },
          {
            id: 'view-monthly',
            target: 'all',
            period: 'monthly',
            limit: 0,
            mode: 'soft',
            periodDays: null,
            periodAnchor: null,
            warnAt: [],
          },
        ],
      },
    ],
    'ai_messages',
    now,
  ).map((entry) => entry.window);
}

export function createSpendingLimitService(
  options: SpendingLimitServiceOptions,
): SpendingLimitService {
  const store: SpendingLimitStore = options.store ?? new InMemorySpendingLimitStore();
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const enforcementDisabledByEnv = (env.VELTRAVIA_SPENDING_LIMITS ?? '').toLowerCase() === 'off';

  const keyOf = (ref: SpendRef & { scope: LimitScope }) => ({
    ownerRef: ref.ownerRef,
    scope: ref.scope,
    workspaceId: ref.scope === 'workspace' ? (ref.workspaceId ?? null) : null,
    projectId: ref.scope === 'project' ? (ref.projectId ?? null) : null,
  });

  const readPlatform = async (): Promise<PlatformLimitPolicy> => {
    const stored = await store.readPlatform();
    return stored ?? DEFAULT_PLATFORM_LIMITS;
  };

  /**
   * The policies in force for a request, broadest first. A scope with no policy
   * of its own does not vanish: it inherits the platform defaults, marked as
   * such, so a screen can say where a number came from.
   */
  const appliedPolicies = async (ref: SpendRef): Promise<AppliedPolicy[]> => {
    const platform = await readPlatform();
    const out: AppliedPolicy[] = [];

    if (ref.workspaceId != null) {
      const workspace = await store.readPolicy({
        ownerRef: ref.ownerRef,
        scope: 'workspace',
        workspaceId: ref.workspaceId,
        projectId: null,
      });
      if (workspace !== null) {
        out.push({
          scope: 'workspace',
          workspaceId: ref.workspaceId,
          projectId: null,
          rules: workspace.rules,
          perOperationLimit: workspace.perOperationLimit,
          maxReservedCredits: workspace.maxReservedCredits,
          source: 'workspace',
        });
      }
    }

    const user = await store.readPolicy({
      ownerRef: ref.ownerRef,
      scope: 'user',
      workspaceId: null,
      projectId: null,
    });
    if (user === null) {
      const defaults = platformDefaults(platform);
      if (defaults.rules.length > 0 || defaults.perOperationLimit !== null) {
        out.push({
          scope: 'user',
          workspaceId: null,
          projectId: null,
          rules: defaults.rules,
          perOperationLimit: defaults.perOperationLimit,
          maxReservedCredits: defaults.maxReservedCredits,
          source: 'platform-default',
          inherited: true,
        });
      }
    } else {
      out.push({
        scope: 'user',
        workspaceId: null,
        projectId: null,
        rules: user.rules,
        perOperationLimit: user.perOperationLimit,
        maxReservedCredits: user.maxReservedCredits,
        source: 'owner',
      });
    }

    if (ref.projectId != null) {
      const project = await store.readPolicy({
        ownerRef: ref.ownerRef,
        scope: 'project',
        workspaceId: null,
        projectId: ref.projectId,
      });
      if (project !== null) {
        out.push({
          scope: 'project',
          workspaceId: null,
          projectId: ref.projectId,
          rules: project.rules,
          perOperationLimit: project.perOperationLimit,
          maxReservedCredits: project.maxReservedCredits,
          source: 'project',
        });
      }
    }

    return out;
  };

  /** Reads both charge lanes for one window and folds them into categories. */
  const samplesFor = async (ref: SpendRef, window: SpendWindow): Promise<SpendSample[]> => {
    const totals = emptyCategories();
    const [messages, integrations] = await Promise.all([
      options.messageCredits.limitUsage(ref, {
        since: window.start,
        until: window.end,
        workspaceId: ref.workspaceId ?? null,
        projectId: ref.projectId ?? null,
      }),
      options.integrationCredits.limitUsage(ref, {
        since: window.start,
        until: window.end,
        workspaceId: ref.workspaceId ?? null,
        projectId: ref.projectId ?? null,
      }),
    ]);

    for (const group of messages) {
      const category = MESSAGE_KIND_CATEGORY[group.key];
      // An unknown kind is not silently filed under a category; it is left out,
      // and the honest consequence is that a limit could under-count it. The
      // dashboard shows it, which is what surfaces the missing mapping.
      if (category === undefined) continue;
      const current = totals[category];
      totals[category] = {
        category,
        committed: creditRound(current.committed + group.committed),
        reserved: creditRound(current.reserved + group.reserved),
        refunded: creditRound(current.refunded + group.refunded),
        charges: current.charges + group.charges,
      };
    }

    for (const group of integrations) {
      const current = totals.integrations;
      totals.integrations = {
        category: 'integrations',
        committed: creditRound(current.committed + group.committed),
        reserved: creditRound(current.reserved + group.reserved),
        refunded: creditRound(current.refunded + group.refunded),
        charges: current.charges + group.charges,
      };
    }

    return Object.values(totals);
  };

  const usageForWindows = async (
    ref: SpendRef,
    windows: readonly SpendWindow[],
  ): Promise<Map<string, readonly SpendSample[]>> => {
    const out = new Map<string, readonly SpendSample[]>();
    // One read per distinct window key, even when three rules share a month.
    const unique = new Map<string, SpendWindow>();
    for (const window of windows) {
      if (!unique.has(window.key)) unique.set(window.key, window);
    }
    await Promise.all(
      [...unique.entries()].map(async ([key, window]) => {
        out.set(key, await samplesFor(ref, window));
      }),
    );
    return out;
  };

  const heldOf = async (ref: SpendRef): Promise<number> => {
    const [messages, integrations] = await Promise.all([
      options.messageCredits.heldCredits(ref),
      options.integrationCredits.heldCredits(ref),
    ]);
    return creditRound(messages + integrations);
  };

  const decide = async (input: AuthorizeInput, record: boolean): Promise<SpendDecision> => {
    const platform = await readPlatform();
    const at = now();
    const policies = await appliedPolicies(input);
    const needed = windowsFor(policies, input.category, at).map((entry) => entry.window);
    const [usage, heldCredits] = await Promise.all([usageForWindows(input, needed), heldOf(input)]);

    const decision = evaluateSpending({
      category: input.category,
      requested: input.requested,
      policies,
      usage,
      heldCredits,
      platform: {
        ...platform,
        enforcementDisabled: platform.enforcementDisabled || enforcementDisabledByEnv,
      },
      now: at,
    });

    if (!record) return decision;

    for (const warning of decision.warnings) {
      const event: LimitEvent = {
        id: newId('sle'),
        ownerRef: input.ownerRef,
        kind: 'warning',
        scope: warning.scope,
        workspaceId: warning.workspaceId,
        projectId: warning.projectId,
        ruleId: warning.ruleId,
        windowKey: warning.windowKey,
        threshold: warning.threshold,
        limit: warning.limit,
        consumed: warning.consumed,
        requested: null,
        message: `You have used ${Math.round((warning.consumed / (warning.limit || 1)) * 100)}% of a ${warning.limit} credit limit (${warning.threshold * 100}% warning).`,
        dedupeKey: warning.dedupeKey,
        actor: input.actor ?? 'system',
        occurredAt: at.toISOString(),
      };
      const appended = await store.appendEvent(event);
      if (appended.created) options.onEvent?.(appended.event);
    }

    if (decision.violation !== null) {
      const violation = decision.violation;
      const event: LimitEvent = {
        id: newId('sle'),
        ownerRef: input.ownerRef,
        kind: violation.reason === 'hard-limit' ? 'limit-reached' : 'operation-refused',
        scope: violation.scope ?? 'user',
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        ruleId: violation.ruleId,
        windowKey: violation.window?.key ?? null,
        threshold: null,
        limit: violation.limit,
        consumed: violation.consumed,
        requested: input.requested,
        message: violation.message,
        // A refusal is a real occurrence, not a repeated one: the key is the
        // refusal's own identity so the history keeps every attempt while a
        // warning stays once-per-window.
        dedupeKey: `refusal|${violation.reason}|${violation.ruleId ?? 'cap'}|${at.toISOString()}|${newId('k')}`,
        actor: input.actor ?? 'system',
        occurredAt: at.toISOString(),
      };
      const appended = await store.appendEvent(event);
      if (appended.created) options.onEvent?.(appended.event);
    }

    return decision;
  };

  const audit = async (
    record: Omit<LimitAuditRecord, 'id' | 'occurredAt'>,
  ): Promise<LimitAuditRecord> => {
    return store.appendAudit({ ...record, id: newId('sla'), occurredAt: now().toISOString() });
  };

  const service: SpendingLimitService = {
    store: store.kind,
    durable: store.kind === 'postgres',

    async policy(key) {
      return store.readPolicy(keyOf(key));
    },

    async policies(ownerRef) {
      return store.listPolicies(ownerRef);
    },

    async savePolicy(input) {
      const platform = await readPlatform();
      const draft: PolicyDraft = {
        ownerRef: input.ownerRef,
        scope: input.scope,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        rules: input.rules,
        perOperationLimit: input.perOperationLimit ?? null,
        maxReservedCredits: input.maxReservedCredits ?? null,
      };
      const normalised = normalisePolicy(draft, platform);
      const previous = await store.readPolicy(keyOf(input));
      const at = now().toISOString();
      const saved = await store.savePolicy(
        {
          id: `${normalised.ownerRef}:${normalised.scope}:${normalised.workspaceId ?? '-'}:${normalised.projectId ?? '-'}`,
          ownerRef: normalised.ownerRef,
          scope: normalised.scope,
          workspaceId: normalised.workspaceId,
          projectId: normalised.projectId,
          rules: normalised.rules,
          perOperationLimit: normalised.perOperationLimit,
          maxReservedCredits: normalised.maxReservedCredits,
          version: previous === null ? 1 : previous.version + 1,
          updatedBy: input.actor,
          updatedAt: at,
          createdAt: previous?.createdAt ?? at,
        },
        input.expectedVersion,
      );
      if (saved === null) {
        throw new SpendingLimitError(
          'STALE_VERSION',
          'These limits changed while you were editing them. Reload and try again.',
          409,
          { expectedVersion: input.expectedVersion },
        );
      }
      await audit({
        ownerRef: saved.ownerRef,
        scope: saved.scope,
        workspaceId: saved.workspaceId,
        projectId: saved.projectId,
        action: previous === null ? 'created' : 'updated',
        actor: input.actor,
        reason: input.reason,
        previous: previous === null ? null : summarise(previous),
        next: summarise(saved),
      });
      return saved;
    },

    async resetPolicy(input) {
      const key = keyOf(input);
      const previous = await store.readPolicy(key);
      if (previous === null) {
        throw new SpendingLimitError('NOT_FOUND', 'No limits are set for that scope.', 404);
      }
      const removed = await store.deletePolicy(key, input.expectedVersion);
      if (!removed) {
        throw new SpendingLimitError(
          'STALE_VERSION',
          'These limits changed while you were editing them. Reload and try again.',
          409,
        );
      }
      await audit({
        ownerRef: key.ownerRef,
        scope: key.scope,
        workspaceId: key.workspaceId,
        projectId: key.projectId,
        action: 'reset',
        actor: input.actor,
        reason: input.reason,
        previous: summarise(previous),
        next: null,
      });
    },

    platform: readPlatform,

    async savePlatform(input) {
      const previous = await readPlatform();
      const normalised = normalisePolicy(
        {
          ownerRef: input.updatedBy,
          scope: 'user',
          rules: input.defaultRules,
          perOperationLimit: input.defaultPerOperationLimit,
          maxReservedCredits:
            input.maxReservedCredits === undefined ? null : input.maxReservedCredits,
        },
        {
          ...previous,
          // The platform's own maximum does not bound its defaults, or the first
          // ceiling ever set could never be raised again.
          maxLimitPerRule: null,
          maxPerOperationLimit: null,
          maxReservedCredits: null,
        },
      );
      const next: PlatformLimitPolicy = {
        maxLimitPerRule: input.maxLimitPerRule,
        maxPerOperationLimit: input.maxPerOperationLimit,
        maxReservedCredits: input.maxReservedCredits,
        defaultRules: normalised.rules,
        defaultPerOperationLimit: normalised.perOperationLimit,
        defaultMaxReservedCredits: normalised.maxReservedCredits,
        enforcementDisabled: input.enforcementDisabled,
        updatedAt: now().toISOString(),
        updatedBy: input.updatedBy,
      };
      const saved = await store.savePlatform(next);
      await audit({
        ownerRef: input.updatedBy,
        scope: 'user',
        workspaceId: null,
        projectId: null,
        action: 'platform-updated',
        actor: input.actor,
        reason: input.reason,
        previous: previous as unknown,
        next: saved as unknown,
      });
      return saved;
    },

    async overview(ref) {
      const platform = await readPlatform();
      const at = now();
      const policies = await appliedPolicies(ref);
      const stored = await store.listPolicies(ref.ownerRef);
      const windows = calendarWindows(at);

      const monthWindow = windows[2] as SpendWindow;
      const usage = await usageForWindows(ref, [monthWindow]);
      const monthSamples = usage.get(monthWindow.key) ?? [];
      const daySamples = await samplesFor(ref, windows[0] as SpendWindow);
      const weekSamples = await samplesFor(ref, windows[1] as SpendWindow);

      /*
       * The live status of every rule, without changing anything and without
       * writing an event. A zero-credit evaluation only reports the rules whose
       * target matches the category it is asked about, so the screen asks once
       * per category the policies name: a coding ceiling belongs on this page
       * even when nobody is chatting.
       */
      const targets = new Set<SpendCategory>();
      for (const policy of policies) {
        for (const entry of policy.rules) {
          if (entry.target !== 'all') targets.add(entry.target);
        }
      }
      targets.add('ai_messages');
      const decisions = await Promise.all(
        [...targets].map((category) =>
          decide({ ...ref, category, requested: 0, actor: 'overview' }, false),
        ),
      );
      const byRule = new Map<string, (typeof decisions)[number]['statuses'][number]>();
      for (const decision of decisions) {
        for (const entry of decision.statuses) {
          if (!byRule.has(entry.ruleId)) byRule.set(entry.ruleId, entry);
        }
      }
      const status = {
        statuses: [...byRule.values()],
        enforcement: decisions[0]?.enforcement ?? 'unconfigured',
      };

      const heldCredits = await heldOf(ref);
      const wallet = options.wallet === undefined ? null : await options.wallet.overview(ref);
      const events = await store.listEvents(ref.ownerRef, { limit: 8 });

      const viewOf = (sample: SpendSample): CategoryUsageView => ({
        category: sample.category,
        label: CATEGORY_LABEL[sample.category],
        committed: sample.committed,
        reserved: sample.reserved,
        refunded: sample.refunded,
        charges: sample.charges,
        // Infrastructure is recorded in quantity by Step 52, not priced in
        // credits, so it is shown but never counted as zero spend.
        priced: sample.category !== 'infrastructure',
      });

      return {
        scopes: [
          {
            scope: 'user',
            workspaceId: null,
            projectId: null,
            policy: stored.find((policy) => policy.scope === 'user') ?? null,
            inherited: stored.every((policy) => policy.scope !== 'user'),
          },
          {
            scope: 'workspace',
            workspaceId: ref.workspaceId ?? null,
            projectId: null,
            policy:
              stored.find(
                (policy) =>
                  policy.scope === 'workspace' && policy.workspaceId === (ref.workspaceId ?? null),
              ) ?? null,
            inherited: true,
          },
          {
            scope: 'project',
            workspaceId: null,
            projectId: ref.projectId ?? null,
            policy:
              stored.find(
                (policy) =>
                  policy.scope === 'project' && policy.projectId === (ref.projectId ?? null),
              ) ?? null,
            inherited: true,
          },
        ],
        limits: status.statuses.map((entry) => ({
          ruleId: entry.ruleId,
          scope: entry.scope,
          target: entry.target,
          period: entry.period,
          mode: entry.mode,
          limit: entry.limit,
          committed: entry.committed,
          reserved: entry.reserved,
          consumed: entry.consumed,
          remaining: entry.remaining,
          ratio: entry.ratio,
          state: entry.state,
          windowStart: entry.window.start,
          windowEnd: entry.window.end,
          source: entry.source,
        })),
        windows: windows.map((window) => ({
          period: window.label,
          start: window.start,
          end: window.end,
        })),
        usage: {
          today: daySamples.map(viewOf),
          week: weekSamples.map(viewOf),
          month: monthSamples.map(viewOf),
        },
        heldCredits,
        perOperationLimit: tightest(policies.map((policy) => policy.perOperationLimit)),
        maxReservedCredits: tightest(policies.map((policy) => policy.maxReservedCredits)),
        enforcement:
          platform.enforcementDisabled || enforcementDisabledByEnv
            ? 'disabled'
            : status.enforcement,
        platform,
        wallet:
          wallet === null
            ? null
            : {
                available: wallet.wallet.available,
                reserved: wallet.wallet.reserved,
                spent: wallet.wallet.spent,
              },
        events: events.map((event) => ({
          id: event.id,
          kind: event.kind,
          scope: event.scope,
          ruleId: event.ruleId,
          message: event.message,
          occurredAt: event.occurredAt,
        })),
        generatedAt: at.toISOString(),
      };
    },

    async events(ownerRef, filter) {
      return store.listEvents(ownerRef, filter);
    },

    async audit(ownerRef, limit) {
      return store.listAudit(ownerRef, { limit });
    },

    authorize: (input) => decide(input, true),
    preview: (input) => decide(input, false),
    heldCredits: (ownerRef) => heldOf({ ownerRef }),
  };

  return service;
}

/** The smallest non-null number, or null when nothing was configured. */
function tightest(values: readonly (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  return numbers.length === 0 ? null : Math.min(...numbers);
}

/** The audit's before/after: the numbers that matter, not the whole row. */
function summarise(policy: SpendingLimitPolicy): unknown {
  return {
    rules: policy.rules,
    perOperationLimit: policy.perOperationLimit,
    maxReservedCredits: policy.maxReservedCredits,
    version: policy.version,
  };
}

/**
 * A refusal is an error the caller may catch, but it is also a normal answer:
 * `authorize` returns the decision rather than throwing, so a route can render
 * the reason instead of turning it into a 500.
 */
export function decisionRefusal(decision: SpendDecision): SpendingLimitError | null {
  if (decision.allowed || decision.violation === null) return null;
  return new SpendingLimitError(
    'LIMIT_REFUSED',
    decision.violation.message,
    decision.violation.reason === 'per-operation-limit' ? 400 : 402,
    {
      reason: decision.violation.reason,
      ruleId: decision.violation.ruleId,
      limit: decision.violation.limit,
      requested: decision.violation.requested,
      consumed: decision.violation.consumed,
      remaining: decision.violation.remaining,
      resetsAt: decision.violation.window?.end ?? null,
    },
  );
}

/**
 * Usage history and cost dashboard (Step 58).
 *
 * This file **reads**. It owns no ledger, no price and no balance: the wallet
 * (Step 53) remains the only thing that says how much credit exists, the
 * message-credit table (Step 54) and the integration-charge table (Step 56) are
 * where each event's story lives, and Step 52's usage records are what the
 * platform measured about storage, bandwidth and realtime.
 *
 * What it adds is the one thing none of those lanes can answer alone: a single,
 * filtered, ordered history across every billable category, with the numbers
 * beside it that explain a month.
 *
 * Three rules hold the honesty of the page together:
 *
 *  1. **A balance is never recomputed here.** Available, reserved and spent come
 *     from the wallet view. This file adds up *charges*, which is a different
 *     question ("what did these events cost") asked of different rows.
 *  2. **A total says how complete it is.** Groupings and trends are read from the
 *     charge rows themselves, up to a stated scan cap. When the cap is reached
 *     the answer carries `complete: false` and a sentence naming the cap, so a
 *     partial sum is never shown as the whole month.
 *  3. **A missing measurement stays missing.** Tokens or units the provider did
 *     not report are `null`, the charge's own `limitations` travel with the event,
 *     and an event with no credit price is labelled as measured-not-charged
 *     rather than being given a zero that looks like a free ride.
 *
 * Deliberately absent: no price table, no currency conversion, no invoice. A
 * credit is a credit; the page says so where a person might expect money.
 */

import type { InteractionKind, MessageCharge } from '@veltravia/message-credits-core';
import type { IntegrationCharge } from '@veltravia/integration-credits-core';
import type { UsageCategory, UsageRecord } from '@veltravia/usage-core';

import type { IntegrationCreditService } from './integration-credit-service.js';
import type { MessageCreditService } from './message-credit-service.js';
import type { UsageService } from './usage-service.js';
import type { WalletEntry } from '@veltravia/wallet-core';

import type { WalletService } from './wallet-service.js';

/** What a person is looking at. One list, used by the feed and the filters. */
export type UsageHistoryCategory =
  | 'ai_messages'
  | 'coding'
  | 'agents'
  | 'reasoning'
  | 'tools'
  | 'background'
  | 'integrations'
  | 'infrastructure';

export interface UsageCategoryDefinition {
  readonly key: UsageHistoryCategory;
  readonly label: string;
  /** Where the records come from, so a category can be checked against a table. */
  readonly source: string;
  /** A category that is measured but not credit-priced says so here. */
  readonly note: string | null;
}

export const USAGE_HISTORY_CATEGORIES: readonly UsageCategoryDefinition[] = [
  {
    key: 'ai_messages',
    label: 'Chat',
    source: 'message_charges (chat.message, chat.assistant)',
    note: null,
  },
  { key: 'coding', label: 'Coding runs', source: 'message_charges (coding.run)', note: null },
  {
    key: 'agents',
    label: 'Agents',
    source: 'message_charges (agent.execution, agent.run)',
    note: null,
  },
  { key: 'reasoning', label: 'Reasoning', source: 'message_charges (reasoning.run)', note: null },
  { key: 'tools', label: 'Tool calls', source: 'message_charges (tool.call)', note: null },
  {
    key: 'background',
    label: 'Background tasks',
    source: 'message_charges (background.task)',
    note: null,
  },
  {
    key: 'integrations',
    label: 'Integrations',
    source: 'integration_charges',
    note: 'Externally billed operations are recorded at zero credits on purpose.',
  },
  {
    key: 'infrastructure',
    label: 'Infrastructure',
    source: 'usage records (Step 52)',
    note: 'Measured quantities with no credit price are shown as measurements, not charges.',
  },
];

const CATEGORY_BY_KEY = new Map(USAGE_HISTORY_CATEGORIES.map((entry) => [entry.key, entry]));

export function isUsageHistoryCategory(value: string): value is UsageHistoryCategory {
  return CATEGORY_BY_KEY.has(value as UsageHistoryCategory);
}

/** Category for each chargeable interaction kind. */
const KIND_CATEGORY: Readonly<Record<InteractionKind, UsageHistoryCategory>> = {
  'chat.message': 'ai_messages',
  'chat.assistant': 'ai_messages',
  'coding.run': 'coding',
  'agent.execution': 'agents',
  'agent.run': 'agents',
  'reasoning.run': 'reasoning',
  'tool.call': 'tools',
  'background.task': 'background',
};

const KIND_LABEL: Readonly<Record<InteractionKind, string>> = {
  'chat.message': 'Chat message',
  'chat.assistant': 'Assistant reply',
  'coding.run': 'Coding run',
  'agent.execution': 'Superagent worker',
  'agent.run': 'Agent run',
  'reasoning.run': 'Reasoning run',
  'tool.call': 'Tool call',
  'background.task': 'Background task',
};

/** Usage categories that are infrastructure rather than model work. */
const INFRASTRUCTURE_RECORD_CATEGORIES: readonly UsageCategory[] = [
  'file_storage',
  'database_storage',
  'bandwidth',
  'realtime',
  'backend_execution',
  'background_jobs',
  'hosting',
];

const INFRASTRUCTURE_LABEL: Readonly<Record<string, string>> = {
  file_storage: 'File storage',
  database_storage: 'Database storage',
  bandwidth: 'Bandwidth',
  realtime: 'Realtime connections',
  backend_execution: 'Backend execution',
  background_jobs: 'Background jobs',
  hosting: 'Hosting',
};

/**
 * How the credits on a record moved. A reservation is not a deduction and a
 * released hold is not a refund, so they are three different words here.
 */
export type UsageMovement =
  'deduction' | 'reservation' | 'release' | 'refund' | 'no-charge' | 'measurement';

export type UsageEventStatus =
  'reserved' | 'committed' | 'released' | 'refunded' | 'exempt' | 'measured';

export type UsageEventSource = 'message' | 'integration' | 'infrastructure';

export interface UsageEventMeasurement {
  readonly unit: string;
  readonly quantity: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly requests: number | null;
  readonly durationMs: number | null;
}

export interface UsageEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly settledAt: string | null;
  readonly source: UsageEventSource;
  readonly category: UsageHistoryCategory;
  readonly categoryLabel: string;
  /** What happened, in words: "Chat message", "File storage". */
  readonly activity: string;
  /** The one-line second column: model, integration operation, measured unit. */
  readonly detail: string;
  readonly movement: UsageMovement;
  readonly status: UsageEventStatus;
  /** Credits this event took. Zero for a released hold, a refusal or a measurement. */
  readonly credits: number;
  /** What was held before the work reported; the estimate, not the bill. */
  readonly estimatedCredits: number;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly modelId: string | null;
  readonly providerId: string | null;
  /** Who pays the provider bill, which is not the same as who pays in credits. */
  readonly providerCharge: 'user' | 'veltravia' | 'none';
  readonly measurement: UsageEventMeasurement | null;
  /** What could not be measured. Empty means everything the charge needed was measured. */
  readonly limitations: readonly string[];
  /** The policy that priced it, so a number can be checked rather than trusted. */
  readonly pricing: {
    readonly policyId: string;
    readonly basis: string;
    readonly byok: boolean;
    readonly note: string;
  };
}

/** Filters a person can set. Every one of them is applied inside the store. */
export interface UsageHistoryFilters {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly categories?: readonly UsageHistoryCategory[] | undefined;
  readonly projectId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly status?: readonly UsageEventStatus[] | undefined;
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly query?: string | undefined;
}

export interface UsageRange {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly days: number;
  readonly since: string;
  readonly until: string;
}

export interface UsageHistoryGroup {
  readonly key: string;
  readonly label: string;
  readonly events: number;
  readonly credits: number;
  /** Share of the credits in the scanned window; 0 when nothing was charged. */
  readonly share: number;
  /** Events in this group that carried no credit price (measurements, exemptions). */
  readonly measured: number;
}

export interface UsageHistoryCompleteness {
  /** False when the scan cap was reached and the totals are a partial sum. */
  readonly complete: boolean;
  readonly scanned: number;
  readonly cap: number;
  readonly note: string;
}

export interface UsageHistoryOverview {
  readonly ownerRef: string;
  readonly at: string;
  readonly range: UsageRange;
  /** The ledger's own numbers. Never recomputed here. */
  readonly wallet: {
    readonly available: number;
    readonly reserved: number;
    readonly spent: number;
    readonly spendable: number;
    readonly currency: string;
    readonly durable: boolean;
    readonly updatedAt: string;
  };
  /** The current calendar month, regardless of the range the page is showing. */
  readonly period: {
    readonly from: string;
    readonly to: string;
    readonly charges: number;
    readonly credits: number;
    readonly refunded: number;
    readonly openCharges: number;
    readonly openCredits: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly cached: number;
      readonly uncached: number;
    };
    readonly integration: { readonly charges: number; readonly credits: number };
    readonly completeness: UsageHistoryCompleteness;
  };
  /** The selected range, for the numbers beside the chart. */
  readonly selected: {
    readonly charges: number;
    readonly credits: number;
    readonly refunded: number;
    readonly released: number;
    readonly byCategory: readonly UsageHistoryGroup[];
    readonly completeness: UsageHistoryCompleteness;
  };
  readonly recent: readonly UsageEvent[];
  readonly infrastructure: {
    readonly measured: readonly {
      readonly category: string;
      readonly label: string;
      readonly quantity: number | null;
      readonly unit: string;
      readonly status: string;
    }[];
    readonly note: string;
  };
  /** Credits that arrived or went back without being a charge (grants, refunds). */
  readonly ledger: {
    readonly creditsAdded: number;
    readonly creditsRefunded: number;
    readonly entries: readonly {
      readonly id: string;
      readonly kind: string;
      readonly amount: number;
      readonly reason: string;
      readonly occurredAt: string;
      readonly balanceAfter: number;
    }[];
    readonly completeness: UsageHistoryCompleteness;
  };
  readonly pricing: {
    readonly catalogVersion: string;
    readonly defaultsOnly: boolean;
    readonly note: string;
    readonly currency: string;
  };
}

export interface UsageHistoryPage {
  readonly ownerRef: string;
  readonly range: UsageRange;
  readonly events: readonly UsageEvent[];
  /** Opaque: pass it back as `cursor` to continue. Null means this was the last page. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Known only when every requested lane could count itself. */
  readonly total: number | null;
  readonly completeness: UsageHistoryCompleteness;
  readonly filters: {
    readonly categories: readonly UsageHistoryCategory[];
    readonly status: readonly UsageEventStatus[];
    readonly projectId: string | null;
    readonly workspaceId: string | null;
    readonly modelId: string | null;
    readonly providerId: string | null;
    readonly query: string | null;
  };
}

export type UsageBreakdownDimension =
  'category' | 'project' | 'model' | 'provider' | 'day' | 'month' | 'activity';

export interface UsageBreakdown {
  readonly ownerRef: string;
  readonly dimension: UsageBreakdownDimension;
  readonly range: UsageRange;
  readonly groups: readonly UsageHistoryGroup[];
  readonly largest: readonly UsageEvent[];
  readonly totals: { readonly events: number; readonly credits: number; readonly measured: number };
  readonly completeness: UsageHistoryCompleteness;
  readonly note: string;
}

export interface UsageHistoryExport {
  readonly csv: string;
  readonly rows: number;
  readonly truncated: boolean;
  readonly range: UsageRange;
}

export class UsageHistoryError extends Error {
  constructor(
    readonly code: 'INVALID_RANGE' | 'INVALID_FILTER' | 'INVALID_CURSOR',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UsageHistoryError';
  }
}

export interface UsageHistoryService {
  overview(ref: UsageHistoryRef): Promise<UsageHistoryOverview>;
  history(
    ref: UsageHistoryRef,
    options: UsageHistoryFilters & { limit?: number; cursor?: string },
  ): Promise<UsageHistoryPage>;
  breakdown(
    ref: UsageHistoryRef,
    options: UsageHistoryFilters & { dimension?: UsageBreakdownDimension },
  ): Promise<UsageBreakdown>;
  exportCsv(ref: UsageHistoryRef, options: UsageHistoryFilters): Promise<UsageHistoryExport>;
  capabilities(): {
    readonly categories: readonly UsageCategoryDefinition[];
    readonly dimensions: readonly UsageBreakdownDimension[];
    readonly scanCap: number;
    readonly notes: readonly string[];
  };
}

export interface UsageHistoryRef {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
}

/**
 * Which wallet scope a read belongs to. The request's own scope wins, because a
 * caller may narrow to a workspace but never widen beyond the one they asked in.
 */
function scopeOf(
  ref: UsageHistoryRef,
  filter: { readonly workspaceId?: string | null },
): string | null {
  return filter.workspaceId === undefined ? (ref.workspaceId ?? null) : filter.workspaceId;
}

export interface UsageHistoryOptions {
  readonly wallet: WalletService;
  readonly messageCredits: MessageCreditService;
  readonly integrationCredits?: IntegrationCreditService | undefined;
  readonly usage: UsageService;
  readonly now?: (() => Date) | undefined;
  /**
   * How many charge rows one aggregation reads before it reports a partial sum.
   * Configurable so a deployment with a long history can raise it, and so a test
   * can prove the partial-sum path without creating five thousand rows.
   */
  readonly scanCap?: number | undefined;
  readonly exportCap?: number | undefined;
}

/** How many charge rows one aggregation may read before it says "partial". */
const DEFAULT_SCAN_CAP = 5000;
/** The largest page the feed will answer. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
/** How many rows an export may contain; a CSV of a whole year is not a download. */
const DEFAULT_EXPORT_CAP = 10_000;
const SCAN_PAGE = 500;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const LEDGER_SCAN = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function startOfUtcDay(date: Date): string {
  return `${date.toISOString().slice(0, 10)}`;
}

function resolveRange(from?: string, to?: string, now: Date = new Date()): UsageRange {
  const today = startOfUtcDay(now);
  const end = to ?? today;
  if (!ISO_DATE.test(end)) {
    throw new UsageHistoryError('INVALID_RANGE', 'The end date must look like 2026-11-12.', 400);
  }
  let start = from;
  if (start === undefined) {
    const back = new Date(`${end}T00:00:00.000Z`);
    back.setUTCDate(back.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
    start = startOfUtcDay(back);
  }
  if (!ISO_DATE.test(start)) {
    throw new UsageHistoryError('INVALID_RANGE', 'The start date must look like 2026-11-12.', 400);
  }
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new UsageHistoryError('INVALID_RANGE', 'The start date is after the end date.', 400);
  }
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new UsageHistoryError(
      'INVALID_RANGE',
      `Pick a range of ${MAX_RANGE_DAYS} days or fewer so the totals stay readable.`,
      400,
    );
  }
  return {
    from: start,
    to: end,
    label: start === end ? start : `${start} to ${end}`,
    days,
    since: `${start}T00:00:00.000Z`,
    until: `${end}T23:59:59.999Z`,
  };
}

function monthRange(now: Date): UsageRange {
  const from = `${now.toISOString().slice(0, 7)}-01`;
  const to = startOfUtcDay(now);
  return resolveRange(from, to, now);
}

const CATEGORY_QUERIES: Readonly<Record<UsageHistoryCategory, readonly InteractionKind[]>> = {
  ai_messages: ['chat.message', 'chat.assistant'],
  coding: ['coding.run'],
  agents: ['agent.execution', 'agent.run'],
  reasoning: ['reasoning.run'],
  tools: ['tool.call'],
  background: ['background.task'],
  integrations: [],
  infrastructure: [],
};

function wantedCategories(filters: UsageHistoryFilters): readonly UsageHistoryCategory[] {
  const requested = filters.categories ?? [];
  if (requested.length === 0) {
    // Infrastructure is excluded from the unfiltered feed on purpose: a bandwidth
    // sample is written once a minute per owner and would drown the charges. It
    // is always visible in the measurement strip and on request.
    return USAGE_HISTORY_CATEGORIES.map((entry) => entry.key).filter(
      (key) => key !== 'infrastructure',
    );
  }
  return requested;
}

function movementOf(state: string, credits: number): UsageMovement {
  if (state === 'reserved') return 'reservation';
  if (state === 'released') return 'release';
  if (state === 'refunded') return 'refund';
  if (state === 'committed') return credits > 0 ? 'deduction' : 'no-charge';
  return 'no-charge';
}

function statusOf(state: string): UsageEventStatus {
  if (state === 'reserved' || state === 'committed' || state === 'released') return state;
  if (state === 'refunded') return 'refunded';
  return 'exempt';
}

function messageEvent(charge: MessageCharge): UsageEvent {
  const category = KIND_CATEGORY[charge.kind] ?? 'ai_messages';
  const model = charge.modelId ?? 'model not reported';
  const provider = charge.providerId ?? 'provider not reported';
  const tokens =
    charge.inputTokens === null && charge.outputTokens === null
      ? 'no token counts reported'
      : `${charge.inputTokens ?? '?'} in / ${charge.outputTokens ?? '?'} out`;
  return {
    id: `charge:${charge.id}`,
    occurredAt: charge.createdAt,
    settledAt: charge.settledAt,
    source: 'message',
    category,
    categoryLabel: CATEGORY_BY_KEY.get(category)?.label ?? category,
    activity: KIND_LABEL[charge.kind] ?? charge.kind,
    detail: `${model} · ${provider} · ${tokens}`,
    movement: movementOf(charge.state, charge.credits),
    status: statusOf(charge.state),
    credits: charge.state === 'committed' || charge.state === 'refunded' ? charge.credits : 0,
    estimatedCredits: charge.estimatedCredits,
    projectId: charge.projectId,
    workspaceId: charge.workspaceId,
    conversationId: charge.conversationId,
    runId: charge.runId,
    taskId: charge.taskId,
    executionId: null,
    modelId: charge.modelId,
    providerId: charge.providerId,
    providerCharge: charge.byok ? 'user' : charge.credits > 0 ? 'veltravia' : 'none',
    measurement:
      charge.inputTokens === null &&
      charge.outputTokens === null &&
      charge.cachedTokens === null &&
      charge.durationMs === null &&
      charge.toolCalls === null
        ? null
        : {
            unit: 'tokens',
            quantity:
              (charge.inputTokens ?? 0) + (charge.outputTokens ?? 0) + (charge.toolCalls ?? 0),
            inputTokens: charge.inputTokens,
            outputTokens: charge.outputTokens,
            cachedTokens: charge.cachedTokens,
            requests: charge.toolCalls,
            durationMs: charge.durationMs,
          },
    limitations: charge.limitations.map(String),
    pricing: {
      policyId: charge.policyId,
      basis: charge.basis,
      byok: charge.byok,
      note: charge.byok
        ? 'Your own provider key paid the provider; Veltravia charged its own price for the interaction only.'
        : 'Priced by the charging policy in force when the interaction settled.',
    },
  };
}

function integrationEvent(charge: IntegrationCharge): UsageEvent {
  const operation = charge.operationId ?? charge.kind;
  const owner = charge.integrationId ?? charge.connectorId ?? 'integration';
  const units = Object.entries(charge.units ?? {})
    .filter(([, value]) => typeof value === 'number')
    .map(([unit, value]) => `${value} ${unit}`)
    .join(', ');
  return {
    id: `integration:${charge.id}`,
    occurredAt: charge.createdAt,
    settledAt: charge.settledAt,
    source: 'integration',
    category: 'integrations',
    categoryLabel: CATEGORY_BY_KEY.get('integrations')?.label ?? 'Integrations',
    activity: `${owner} · ${operation}`,
    detail:
      [
        charge.billingClass === 'externally-billed'
          ? 'billed by the external service'
          : charge.billingClass === 'free'
            ? 'free integration'
            : 'paid integration',
        units === '' ? null : units,
        charge.requests === null ? null : `${charge.requests} request(s)`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ') || operation,
    movement: movementOf(charge.state, charge.credits),
    status: statusOf(charge.state),
    credits: charge.state === 'committed' || charge.state === 'refunded' ? charge.credits : 0,
    estimatedCredits: charge.estimatedCredits,
    projectId: charge.projectId,
    workspaceId: charge.workspaceId,
    conversationId: null,
    runId: charge.executionId,
    taskId: null,
    executionId: charge.executionId,
    modelId: null,
    providerId: null,
    providerCharge:
      charge.billingClass === 'externally-billed'
        ? 'user'
        : charge.credits > 0
          ? 'veltravia'
          : 'none',
    measurement:
      charge.requests === null && Object.keys(charge.units ?? {}).length === 0
        ? null
        : {
            unit: 'calls',
            quantity: charge.requests ?? 0,
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            requests: charge.requests,
            durationMs: charge.durationMs,
          },
    limitations: charge.limitations.map(String),
    pricing: {
      policyId: charge.policyId,
      basis: charge.basis,
      byok: charge.byok,
      note:
        charge.billingClass === 'externally-billed'
          ? 'The external service bills your own account; Veltravia records the use but takes no credit for it.'
          : 'Priced by the integration catalog in force when the operation settled.',
    },
  };
}

function infrastructureEvent(record: UsageRecord): UsageEvent {
  const service = INFRASTRUCTURE_LABEL[record.category] ?? record.category;
  return {
    id: `usage:${record.id}`,
    occurredAt: record.occurredAt,
    settledAt: null,
    source: 'infrastructure',
    category: 'infrastructure',
    categoryLabel: CATEGORY_BY_KEY.get('infrastructure')?.label ?? 'Infrastructure',
    activity: service,
    detail: `${record.operation} · ${record.quantity} ${record.unit} · ${record.source}`,
    movement: 'measurement',
    status: 'measured',
    credits: 0,
    estimatedCredits: 0,
    projectId: record.projectId,
    workspaceId: null,
    conversationId: null,
    runId: record.executionId,
    taskId: record.taskId,
    executionId: record.executionId,
    modelId: record.modelId,
    providerId: record.providerId,
    providerCharge: record.costBearer === 'user_provider' ? 'user' : 'none',
    measurement: {
      unit: record.unit,
      quantity: record.quantity,
      inputTokens: record.unit === 'tokens' ? record.quantity : null,
      outputTokens: null,
      cachedTokens: null,
      requests: record.unit === 'calls' ? record.quantity : null,
      durationMs: record.unit === 'milliseconds' ? record.quantity : null,
    },
    limitations: [],
    pricing: {
      policyId: 'none',
      basis: 'unmeasured',
      byok: record.costBearer === 'user_provider',
      note: 'Infrastructure is metered against quotas, not priced in credits. Shown so the use is visible.',
    },
  };
}

/** Newest first, ties broken by id, exactly as the stores sort their own pages. */
function compareEvents(a: UsageEvent, b: UsageEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * A page boundary.
 *
 * The feed merges three lanes whose ids are not comparable with each other, so a
 * single id cannot say where the last page ended. Instead the boundary records,
 * per lane, the last row that was shown: that lane then continues strictly below
 * its own row, and a lane that contributed nothing continues below the timestamp
 * itself (`~` sorts above every id, so its equally-timed rows are still offered
 * rather than skipped).
 *
 * This is what makes a page neither repeat nor skip a charge: charges written in
 * the same millisecond are common whenever a run settles several at once.
 */
interface FeedCursor {
  readonly at: string;
  readonly bounds: Readonly<Record<UsageEventSource, string>>;
}

const CURSOR_SOURCES: readonly UsageEventSource[] = ['message', 'integration', 'infrastructure'];
/** Sorts above any id the stores produce, so "everything at this instant" is fair. */
const OPEN_BOUND = '~';

/** The store's own id, without the lane prefix this feed adds for display. */
function rawIdOf(event: UsageEvent): string {
  const colon = event.id.indexOf(':');
  return colon < 0 ? event.id : event.id.slice(colon + 1);
}

function afterCursor(event: UsageEvent, cursor: FeedCursor | null): boolean {
  if (cursor === null) return true;
  if (event.occurredAt !== cursor.at) return event.occurredAt < cursor.at;
  return rawIdOf(event) < (cursor.bounds[event.source] ?? OPEN_BOUND);
}

function encodeCursor(shown: readonly UsageEvent[]): string {
  const at = shown[shown.length - 1]?.occurredAt ?? '';
  const bounds: Record<UsageEventSource, string> = {
    message: OPEN_BOUND,
    integration: OPEN_BOUND,
    infrastructure: OPEN_BOUND,
  };
  for (const event of shown) {
    if (event.occurredAt === at) bounds[event.source] = rawIdOf(event);
  }
  return [at, ...CURSOR_SOURCES.map((source) => bounds[source])].join('|');
}

function decodeCursor(raw: string | undefined): FeedCursor | null {
  if (raw === undefined || raw === '') return null;
  const parts = raw.split('|');
  const at = parts[0];
  if (at === undefined || at === '') {
    throw new UsageHistoryError('INVALID_CURSOR', 'That page link is not usable any more.', 400);
  }
  const bounds: Record<UsageEventSource, string> = {
    message: parts[1] ?? OPEN_BOUND,
    integration: parts[2] ?? OPEN_BOUND,
    infrastructure: parts[3] ?? OPEN_BOUND,
  };
  return { at, bounds };
}

function matchesStatus(event: UsageEvent, statuses: readonly UsageEventStatus[]): boolean {
  return statuses.length === 0 || statuses.includes(event.status);
}

/**
 * Totals over a set of events. `credits` counts what was taken, which is the
 * committed or refunded amount on the row; a released hold contributed nothing.
 */
function summarise(events: readonly UsageEvent[]): {
  charges: number;
  credits: number;
  refunded: number;
  released: number;
  measured: number;
} {
  let credits = 0;
  let refunded = 0;
  let released = 0;
  let measured = 0;
  for (const event of events) {
    if (event.movement === 'measurement') measured += 1;
    if (event.movement === 'release') released += 1;
    if (event.status === 'refunded') refunded += event.credits;
    else if (event.movement === 'deduction') credits += event.credits;
  }
  return {
    charges: events.length - measured,
    credits: round(credits),
    refunded: round(refunded),
    released,
    measured,
  };
}

function completenessNote(complete: boolean, scanned: number, cap: number, what: string): string {
  return complete
    ? `${what}: every record in this range was read (${scanned}).`
    : `${what}: read the most recent ${scanned} of more than ${cap} records, so the totals are a partial sum. Narrow the date range for an exact figure.`;
}

export function createUsageHistoryService(options: UsageHistoryOptions): UsageHistoryService {
  const now = options.now ?? (() => new Date());
  const SCAN_CAP = Math.max(1, Math.trunc(options.scanCap ?? DEFAULT_SCAN_CAP));
  const EXPORT_CAP = Math.max(SCAN_CAP, Math.trunc(options.exportCap ?? DEFAULT_EXPORT_CAP));

  const messagePage = async (
    ref: UsageHistoryRef,
    filter: {
      limit: number;
      offset?: number;
      since?: string;
      until?: string;
      beforeAt?: string;
      beforeId?: string;
      kind?: InteractionKind;
      state?: string;
      workspaceId?: string | null;
      projectId?: string;
      modelId?: string;
      providerId?: string;
      query?: string;
    },
  ): Promise<{ events: UsageEvent[]; total: number }> => {
    const page = (await options.messageCredits.charges(
      {
        ownerRef: ref.ownerRef,
        ...(scopeOf(ref, filter) === null ? {} : { workspaceId: scopeOf(ref, filter) }),
      },
      {
        limit: filter.limit,
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
        ...(filter.since === undefined ? {} : { since: filter.since }),
        ...(filter.until === undefined ? {} : { until: filter.until }),
        ...(filter.beforeAt === undefined ? {} : { beforeAt: filter.beforeAt }),
        ...(filter.beforeId === undefined ? {} : { beforeId: filter.beforeId }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.state === undefined ? {} : { state: filter.state as never }),
        ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
        ...(filter.modelId === undefined ? {} : { modelId: filter.modelId }),
        ...(filter.providerId === undefined ? {} : { providerId: filter.providerId }),
        ...(filter.query === undefined ? {} : { query: filter.query }),
      } as never,
    )) as { charges: readonly MessageCharge[]; total: number };
    return { events: page.charges.map(messageEvent), total: page.total };
  };

  const integrationPage = async (
    ref: UsageHistoryRef,
    filter: {
      limit: number;
      offset?: number;
      since?: string;
      until?: string;
      beforeAt?: string;
      beforeId?: string;
      state?: string;
      workspaceId?: string | null;
      projectId?: string;
      query?: string;
    },
  ): Promise<{ events: UsageEvent[]; total: number }> => {
    if (options.integrationCredits === undefined) return { events: [], total: 0 };
    const page = (await options.integrationCredits.charges(
      {
        ownerRef: ref.ownerRef,
        ...(scopeOf(ref, filter) === null ? {} : { workspaceId: scopeOf(ref, filter) }),
      },
      {
        limit: filter.limit,
        ...(filter.offset === undefined ? {} : { offset: filter.offset }),
        ...(filter.since === undefined ? {} : { since: filter.since }),
        ...(filter.until === undefined ? {} : { until: filter.until }),
        ...(filter.beforeAt === undefined ? {} : { beforeAt: filter.beforeAt }),
        ...(filter.beforeId === undefined ? {} : { beforeId: filter.beforeId }),
        ...(filter.state === undefined ? {} : { state: filter.state as never }),
        ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
        ...(filter.query === undefined ? {} : { query: filter.query }),
      } as never,
    )) as { charges: readonly IntegrationCharge[]; total: number };
    return { events: page.charges.map(integrationEvent), total: page.total };
  };

  const infrastructureEvents = async (
    ref: UsageHistoryRef,
    filters: UsageHistoryFilters,
    range: UsageRange,
    limit: number,
    boundary: FeedCursor | null = null,
  ): Promise<UsageEvent[]> => {
    const records = await options.usage.records(ref.ownerRef, {
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      limit,
    });
    return records
      .filter((record) => record.category !== 'ai_provider')
      .filter((record) =>
        (INFRASTRUCTURE_RECORD_CATEGORIES as readonly string[]).includes(record.category),
      )
      .filter((record) => record.occurredAt >= range.since && record.occurredAt <= range.until)
      .map(infrastructureEvent)
      .filter((event) => afterCursor(event, boundary));
  };

  /**
   * One filtered page across every requested lane.
   *
   * The boundary is a point in time, not an offset: each lane is asked for rows
   * at or before it and returns its own newest few, so the merged page is the
   * true newest page even while new charges keep arriving between requests.
   */
  const readPage = async (
    ref: UsageHistoryRef,
    filters: UsageHistoryFilters,
    limit: number,
    cursor: FeedCursor | null,
  ): Promise<{ events: UsageEvent[]; total: number | null; scanned: number }> => {
    const range = resolveRange(filters.from, filters.to, now());
    const categories = wantedCategories(filters);
    const keysetFor = (source: UsageEventSource): { beforeAt?: string; beforeId?: string } =>
      cursor === null ? {} : { beforeAt: cursor.at, beforeId: cursor.bounds[source] ?? OPEN_BOUND };
    const statuses = filters.status ?? [];
    const singleState = statuses.length === 1 ? statuses[0] : undefined;
    if (singleState !== undefined && singleState === 'measured') {
      // Measurements are not charges; asking the charge tables for that state
      // would return nothing and look like an empty account.
      return { events: [], total: 0, scanned: 0 };
    }
    const kinds = categories.flatMap((category) => CATEGORY_QUERIES[category] ?? []);
    const wantsIntegrations = categories.includes('integrations');
    const wantsInfrastructure = categories.includes('infrastructure');
    // A model or provider filter names a model charge; an integration charge has
    // neither, so it cannot match and asking for it would only inflate `total`.
    const narrowed = filters.modelId !== undefined || filters.providerId !== undefined;
    const scope = filters.workspaceId ?? ref.workspaceId ?? null;
    const label = {
      ...(scope === null ? {} : { workspaceId: scope }),
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(filters.modelId === undefined ? {} : { modelId: filters.modelId }),
      ...(filters.providerId === undefined ? {} : { providerId: filters.providerId }),
      ...(filters.query === undefined || filters.query.trim() === ''
        ? {}
        : { query: filters.query.trim() }),
      since: range.since,
      until: range.until,
      ...(singleState === undefined ? {} : { state: singleState }),
    };

    const lanes: (() => Promise<{ events: UsageEvent[]; total: number }>)[] = kinds.map(
      (kind) => () =>
        messagePage(ref, { ...label, ...keysetFor('message'), limit: limit + 1, kind }),
    );
    if (wantsIntegrations && !narrowed) {
      lanes.push(() =>
        integrationPage(ref, { ...label, ...keysetFor('integration'), limit: limit + 1 }),
      );
    }

    const lanesRead = await Promise.all(lanes.map((read) => read()));
    const merged: UsageEvent[] = [];
    for (const lane of lanesRead) merged.push(...lane.events);

    /*
     * The matching count is asked for separately, without the page boundary.
     * Counting the page instead would make `total` shrink with every page, which
     * turns "3 of 7" into "3 of 4" for no reason a person could follow.
     */
    const counts = await Promise.all(
      kinds.map((kind) => messagePage(ref, { ...label, limit: 1, kind })),
    );
    let countable = true;
    let total = counts.reduce((sum, lane) => sum + lane.total, 0);
    if (wantsIntegrations && !narrowed) {
      const integration = await integrationPage(ref, { ...label, limit: 1 });
      total += integration.total;
    }
    if (wantsInfrastructure && !narrowed) {
      merged.push(...(await infrastructureEvents(ref, filters, range, limit + 1, cursor)));
      countable = false;
    }
    const events = merged
      .filter((event) => matchesStatus(event, statuses))
      .filter((event) => afterCursor(event, cursor))
      .sort(compareEvents);
    return {
      events: events.slice(0, limit + 1),
      total: countable ? total : null,
      scanned: merged.length,
    };
  };

  /**
   * Reads one lane's rows in offset pages up to `cap`.
   *
   * Aggregations cannot page by cursor because they need the whole window, so
   * they walk the store page by page and stop at the cap. The page's own `total`
   * is what makes `complete` honest: if the cap is below it, the answer says so.
   */
  const scan = async (
    ref: UsageHistoryRef,
    filters: UsageHistoryFilters,
    range: UsageRange,
    cap: number,
  ): Promise<{
    events: UsageEvent[];
    complete: boolean;
    scanned: number;
    totals: { message: number; integration: number };
  }> => {
    const categories = wantedCategories(filters);
    const kinds = categories.flatMap((category) => CATEGORY_QUERIES[category] ?? []);
    const wantsIntegrations = categories.includes('integrations');
    const statuses = filters.status ?? [];
    const singleState = statuses.length === 1 ? statuses[0] : undefined;
    const scope = filters.workspaceId ?? ref.workspaceId ?? null;
    const label = {
      ...(scope === null ? {} : { workspaceId: scope }),
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(filters.modelId === undefined ? {} : { modelId: filters.modelId }),
      ...(filters.providerId === undefined ? {} : { providerId: filters.providerId }),
      ...(filters.query === undefined || filters.query.trim() === ''
        ? {}
        : { query: filters.query.trim() }),
      since: range.since,
      until: range.until,
    };
    const events: UsageEvent[] = [];
    let complete = true;
    let scanned = 0;
    const totals = { message: 0, integration: 0 };

    const lanes: {
      run: (limit: number, offset: number) => Promise<{ events: UsageEvent[]; total: number }>;
      key: 'message' | 'integration';
    }[] = [];
    for (const kind of kinds) {
      lanes.push({
        key: 'message',
        run: (limit, offset) =>
          messagePage(ref, {
            ...label,
            limit,
            offset,
            kind,
            ...(singleState === undefined ? {} : { state: singleState }),
          }),
      });
    }
    if (wantsIntegrations) {
      lanes.push({
        key: 'integration',
        run: (limit, offset) =>
          integrationPage(ref, {
            ...label,
            limit,
            offset,
            ...(singleState === undefined ? {} : { state: singleState }),
          }),
      });
    }

    for (const lane of lanes) {
      let offset = 0;
      let laneTotal = 0;
      let stoppedAtCap = false;
      for (;;) {
        try {
          const page = await lane.run(SCAN_PAGE, offset);
          laneTotal = Math.max(laneTotal, page.total);
          totals[lane.key] += page.total;
          for (const event of page.events) {
            // The cap is a real stop: a page cut in half is a partial sum, even
            // when the store's own total was reached by the fetch.
            if (events.length >= cap) {
              stoppedAtCap = true;
              break;
            }
            events.push(event);
            scanned += 1;
          }
          if (stoppedAtCap) break;
          offset += page.events.length;
          if (page.events.length < SCAN_PAGE || offset >= page.total) break;
        } catch {
          // A lane that cannot be read is a gap in the total, never a crash.
          complete = false;
          break;
        }
      }
      if (stoppedAtCap || offset < laneTotal) complete = false;
    }

    if (categories.includes('infrastructure')) {
      const infra = await infrastructureEvents(ref, filters, range, SCAN_PAGE);
      events.push(...infra);
      scanned += infra.length;
    }

    return {
      events: events.filter((event) => matchesStatus(event, statuses)).sort(compareEvents),
      complete,
      scanned,
      totals,
    };
  };

  const groupEvents = (
    events: readonly UsageEvent[],
    dimension: UsageBreakdownDimension,
    range: UsageRange,
  ): UsageHistoryGroup[] => {
    const buckets = new Map<
      string,
      { label: string; events: number; credits: number; measured: number }
    >();
    for (const event of events) {
      const key =
        dimension === 'category'
          ? event.category
          : dimension === 'project'
            ? (event.projectId ?? 'no-project')
            : dimension === 'model'
              ? (event.modelId ?? 'no-model')
              : dimension === 'provider'
                ? (event.providerId ?? 'no-provider')
                : dimension === 'day'
                  ? event.occurredAt.slice(0, 10)
                  : dimension === 'month'
                    ? event.occurredAt.slice(0, 7)
                    : event.activity;
      const label =
        dimension === 'category'
          ? event.categoryLabel
          : key === 'no-project'
            ? 'No project'
            : key === 'no-model'
              ? 'No model reported'
              : key === 'no-provider'
                ? 'No provider reported'
                : key;
      const bucket = buckets.get(key) ?? { label, events: 0, credits: 0, measured: 0 };
      bucket.events += 1;
      if (event.movement === 'measurement' || event.movement === 'no-charge') bucket.measured += 1;
      else if (event.movement === 'deduction')
        bucket.credits = round(bucket.credits + event.credits);
      buckets.set(key, bucket);
    }
    // A trend with gaps is a trend that lies, so a bounded day range is filled.
    if (dimension === 'day' && range.days <= 62) {
      for (let index = 0; index < range.days; index += 1) {
        const day = new Date(`${range.from}T00:00:00.000Z`);
        day.setUTCDate(day.getUTCDate() + index);
        const key = startOfUtcDay(day);
        if (!buckets.has(key)) buckets.set(key, { label: key, events: 0, credits: 0, measured: 0 });
      }
    }
    const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.credits, 0);
    return [...buckets.entries()]
      .map(([key, bucket]) => ({
        key,
        label: bucket.label,
        events: bucket.events,
        credits: round(bucket.credits),
        share: total === 0 ? 0 : round(bucket.credits / total),
        measured: bucket.measured,
      }))
      .sort((a, b) =>
        dimension === 'day' || dimension === 'month'
          ? a.key.localeCompare(b.key)
          : b.credits - a.credits || a.key.localeCompare(b.key),
      );
  };

  const history: UsageHistoryService['history'] = async (ref, opts) => {
    const range = resolveRange(opts.from, opts.to, now());
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
    const page = await readPage(ref, opts, limit, decodeCursor(opts.cursor));
    const events = page.events.slice(0, limit);
    return {
      ownerRef: ref.ownerRef,
      range,
      events,
      nextCursor: page.events.length > limit ? encodeCursor(events) : null,
      hasMore: page.events.length > limit,
      total: page.total,
      completeness: {
        complete: page.total === null ? false : page.scanned <= limit + 1,
        scanned: page.scanned,
        cap: limit,
        note:
          page.total === null
            ? 'This page mixes charges with infrastructure measurements, which do not share a counter, so the matching count is not shown.'
            : `${page.total} record(s) match these filters.`,
      },
      filters: {
        categories: wantedCategories(opts),
        status: opts.status ?? [],
        projectId: opts.projectId ?? null,
        workspaceId: ref.workspaceId ?? null,
        modelId: opts.modelId ?? null,
        providerId: opts.providerId ?? null,
        query: opts.query ?? null,
      },
    };
  };

  const overview: UsageHistoryService['overview'] = async (ref) => {
    const at = now();
    const range = resolveRange(undefined, undefined, at);
    const period = monthRange(at);
    const wallet = await options.wallet.overview({
      ownerRef: ref.ownerRef,
      ...(ref.workspaceId == null ? {} : { workspaceId: ref.workspaceId }),
      limit: 1,
    });

    const [periodScan, rangeScan, ledger] = await Promise.all([
      scan(ref, {}, period, SCAN_CAP),
      scan(ref, {}, range, SCAN_CAP),
      options.wallet.history({
        ownerRef: ref.ownerRef,
        ...(ref.workspaceId == null ? {} : { workspaceId: ref.workspaceId }),
        limit: LEDGER_SCAN,
      }),
    ]);

    const periodSummary = summarise(periodScan.events);
    const rangeSummary = summarise(rangeScan.events);
    const periodMessages = periodScan.events.filter((event) => event.source === 'message');
    const periodIntegration = periodScan.events.filter((event) => event.source === 'integration');
    const tokens = periodMessages.reduce(
      (totals, event) => ({
        input: totals.input + (event.measurement?.inputTokens ?? 0),
        output: totals.output + (event.measurement?.outputTokens ?? 0),
        cached: totals.cached + (event.measurement?.cachedTokens ?? 0),
      }),
      { input: 0, output: 0, cached: 0 },
    );

    const entriesInRange = ledger.filter(
      (entry: WalletEntry) => entry.occurredAt >= range.since && entry.occurredAt <= range.until,
    );
    const creditsAdded = round(
      entriesInRange
        .filter(
          (entry: WalletEntry) =>
            (entry.kind === 'purchase' ||
              entry.kind === 'grant' ||
              entry.kind === 'promotion' ||
              entry.kind === 'adjustment_credit') &&
            entry.availableDelta > 0,
        )
        .reduce((sum: number, entry: WalletEntry) => sum + entry.availableDelta, 0),
    );
    const creditsRefunded = round(
      entriesInRange
        .filter((entry: WalletEntry) => entry.kind === 'refund')
        .reduce((sum: number, entry: WalletEntry) => sum + Math.max(0, entry.availableDelta), 0),
    );

    const snapshot = await options.usage.snapshot(ref.ownerRef, {});
    const coverage = options.usage.capabilities();
    const counters = snapshot.counters as unknown as Record<string, number | undefined>;
    const infra = INFRASTRUCTURE_RECORD_CATEGORIES.map((category) => {
      const capability = coverage.categories.find((entry) => entry.category === category);
      const quantity = counters[category];
      return {
        category: category as string,
        label: INFRASTRUCTURE_LABEL[category] ?? category,
        quantity: typeof quantity === 'number' ? quantity : null,
        unit: capability?.unit ?? 'count',
        // "measured" is the platform's own word for what it watched happen; a
        // category it merely estimates says so instead of borrowing the word.
        status: capability?.status ?? 'unavailable',
      };
    });

    return {
      ownerRef: ref.ownerRef,
      at: at.toISOString(),
      range,
      wallet: {
        available: wallet.wallet.available,
        reserved: wallet.wallet.reserved,
        spent: wallet.wallet.spent,
        spendable: wallet.wallet.spendable,
        currency: wallet.wallet.currency,
        durable: wallet.durable,
        updatedAt: wallet.wallet.updatedAt,
      },
      period: {
        from: period.from,
        to: period.to,
        charges: periodSummary.charges,
        credits: periodSummary.credits,
        refunded: periodSummary.refunded,
        openCharges: periodScan.events.filter((event) => event.status === 'reserved').length,
        openCredits: round(
          periodScan.events
            .filter((event) => event.status === 'reserved')
            .reduce((sum, event) => sum + event.estimatedCredits, 0),
        ),
        tokens: {
          input: tokens.input,
          output: tokens.output,
          cached: Math.min(tokens.cached, tokens.input),
          uncached: Math.max(0, tokens.input - tokens.cached),
        },
        integration: {
          charges: periodIntegration.length,
          credits: round(
            periodIntegration.reduce(
              (sum, event) => sum + (event.movement === 'deduction' ? event.credits : 0),
              0,
            ),
          ),
        },
        completeness: {
          complete: periodScan.complete,
          scanned: periodScan.scanned,
          cap: SCAN_CAP,
          note: completenessNote(periodScan.complete, periodScan.scanned, SCAN_CAP, 'This month'),
        },
      },
      selected: {
        charges: rangeSummary.charges,
        credits: rangeSummary.credits,
        refunded: rangeSummary.refunded,
        released: rangeSummary.released,
        byCategory: groupEvents(rangeScan.events, 'category', range),
        completeness: {
          complete: rangeScan.complete,
          scanned: rangeScan.scanned,
          cap: SCAN_CAP,
          note: completenessNote(rangeScan.complete, rangeScan.scanned, SCAN_CAP, 'This range'),
        },
      },
      recent: rangeScan.events.slice(0, 8),
      infrastructure: {
        measured: infra,
        note: 'Counters are this period’s metered use. They are quotas, not credits: no credit price is configured for storage, bandwidth or realtime.',
      },
      ledger: {
        creditsAdded,
        creditsRefunded,
        entries: entriesInRange.slice(0, 10).map((entry: WalletEntry) => ({
          id: entry.id,
          kind: entry.kind,
          amount: entry.amount,
          reason: entry.reason,
          occurredAt: entry.occurredAt,
          balanceAfter: entry.balanceAfter,
        })),
        completeness: {
          complete:
            ledger.length < LEDGER_SCAN ||
            (entriesInRange[entriesInRange.length - 1]?.occurredAt ?? '') <= range.since,
          scanned: ledger.length,
          cap: LEDGER_SCAN,
          note:
            ledger.length < LEDGER_SCAN
              ? 'Every ledger entry was read.'
              : 'Only the most recent ledger entries were read; earlier additions to the balance are not counted here.',
        },
      },
      pricing: {
        catalogVersion: options.messageCredits.catalog.version,
        defaultsOnly: options.messageCredits.catalog.defaultsOnly,
        note: options.messageCredits.catalog.defaultsOnly
          ? 'Credits are priced by configurable defaults shipped with Veltravia. They are not a currency and have no cash value here.'
          : 'Credits are priced by this deployment. They are not a currency and have no cash value here.',
        currency: options.messageCredits.catalog.currency,
      },
    };
  };

  const breakdown: UsageHistoryService['breakdown'] = async (ref, opts) => {
    const range = resolveRange(opts.from, opts.to, now());
    const dimension = opts.dimension ?? 'category';
    const scanned = await scan(ref, opts, range, SCAN_CAP);
    const summary = summarise(scanned.events);
    return {
      ownerRef: ref.ownerRef,
      dimension,
      range,
      groups: groupEvents(scanned.events, dimension, range),
      largest: [...scanned.events]
        .filter((event) => event.movement === 'deduction')
        .sort((a, b) => b.credits - a.credits || compareEvents(a, b))
        .slice(0, 5),
      totals: {
        events: scanned.events.length,
        credits: summary.credits,
        measured: summary.measured,
      },
      completeness: {
        complete: scanned.complete,
        scanned: scanned.scanned,
        cap: SCAN_CAP,
        note: completenessNote(scanned.complete, scanned.scanned, SCAN_CAP, 'This breakdown'),
      },
      note:
        dimension === 'model' || dimension === 'provider'
          ? 'Integration charges carry no model or provider, so they are grouped as "not reported" here.'
          : dimension === 'day' || dimension === 'month'
            ? 'Days with nothing recorded are shown as zero rather than left out.'
            : 'Grouped from the charge records themselves, not from the ledger balance.',
    };
  };

  const csvCell = (value: string | number | null): string => {
    if (value === null) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const exportCsv: UsageHistoryService['exportCsv'] = async (ref, opts) => {
    const range = resolveRange(opts.from, opts.to, now());
    const scanned = await scan(ref, opts, range, EXPORT_CAP);
    const header = [
      'occurred_at',
      'settled_at',
      'category',
      'activity',
      'detail',
      'status',
      'movement',
      'credits',
      'estimated_credits',
      'model',
      'provider',
      'provider_charge',
      'project_id',
      'workspace_id',
      'run_id',
      'task_id',
      'conversation_id',
      'input_tokens',
      'output_tokens',
      'cached_tokens',
      'measured_quantity',
      'measured_unit',
      'pricing_policy',
      'pricing_basis',
      'byok',
      'limitations',
      'record_id',
      'source',
    ];
    const lines = [header.join(',')];
    for (const event of scanned.events) {
      lines.push(
        [
          event.occurredAt,
          event.settledAt,
          event.category,
          event.activity,
          event.detail,
          event.status,
          event.movement,
          event.credits,
          event.estimatedCredits,
          event.modelId,
          event.providerId,
          event.providerCharge,
          event.projectId,
          event.workspaceId,
          event.runId,
          event.taskId,
          event.conversationId,
          event.measurement?.inputTokens ?? null,
          event.measurement?.outputTokens ?? null,
          event.measurement?.cachedTokens ?? null,
          event.measurement?.quantity ?? null,
          event.measurement?.unit ?? null,
          event.pricing.policyId,
          event.pricing.basis,
          event.pricing.byok ? 'true' : 'false',
          event.limitations.join(' '),
          event.id,
          event.source,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return {
      csv: `${lines.join('\n')}\n`,
      rows: scanned.events.length,
      truncated: !scanned.complete,
      range,
    };
  };

  return {
    overview,
    history,
    breakdown,
    exportCsv,
    capabilities: () => ({
      categories: USAGE_HISTORY_CATEGORIES,
      dimensions: ['category', 'project', 'model', 'provider', 'day', 'month', 'activity'],
      scanCap: SCAN_CAP,
      notes: [
        'Balances come from the credit wallet ledger; totals come from the charge records and say when they are partial.',
        'A reservation, a deduction, a released hold and a refund are four different movements and are never added together.',
        'Storage, bandwidth and realtime are metered against quotas and have no credit price, so they appear as measurements.',
        'Credits are not a currency here: no cash value is derived or implied.',
      ],
    }),
  };
}

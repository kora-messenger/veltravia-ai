/**
 * Message charges in PostgreSQL (Step 54).
 *
 * `insertCharge` relies on the unique `(owner_ref, idempotency_key)` index: on a
 * retry the insert does nothing and the existing row is read back, so a request
 * that arrives twice is charged once. `saveCharge` is a compare-and-set on the
 * state, which is what stops two settlements of one hold from both posting.
 */

import type {
  ChargeFilter,
  ChargePage,
  MessageCharge,
  MessageCreditStore,
  SpendingSettings,
  UsageDimension,
  UsageGroup,
} from '@veltravia/message-credits-core';

import { type Database } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface ChargeRow {
  owner_ref: string;
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  task_id: string | null;
  parent_charge_id: string | null;
  usage_operation_key: string | null;
  kind: MessageCharge['kind'];
  model_id: string | null;
  provider_id: string | null;
  byok: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  duration_ms: string | null;
  tool_calls: number | null;
  credits: string;
  estimated_credits: string;
  state: MessageCharge['state'];
  basis: MessageCharge['basis'];
  policy_id: string;
  limitations: MessageCharge['limitations'] | null;
  measurement_source: MessageCharge['measurementSource'];
  cached_savings: string | null;
  idempotency_key: string;
  reservation_id: string | null;
  wallet_entry_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  settled_at: Date | null;
  refunded_at: Date | null;
}

const num = (value: string | number | null): number | null => {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toCharge = (row: ChargeRow): MessageCharge => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  projectId: row.project_id,
  conversationId: row.conversation_id,
  runId: row.run_id,
  taskId: row.task_id,
  parentChargeId: row.parent_charge_id,
  usageOperationKey: row.usage_operation_key,
  kind: row.kind,
  modelId: row.model_id,
  providerId: row.provider_id,
  byok: row.byok,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedTokens: row.cached_tokens,
  durationMs: num(row.duration_ms),
  toolCalls: row.tool_calls,
  credits: num(row.credits) ?? 0,
  estimatedCredits: num(row.estimated_credits) ?? 0,
  state: row.state,
  basis: row.basis,
  policyId: row.policy_id,
  limitations: row.limitations ?? [],
  measurementSource: row.measurement_source ?? null,
  cachedSavings: num(row.cached_savings),
  idempotencyKey: row.idempotency_key,
  reservationId: row.reservation_id,
  walletEntryId: row.wallet_entry_id,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at).toISOString(),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at).toISOString(),
});

const COLUMNS = `owner_ref, id, workspace_id, project_id, conversation_id, run_id, task_id,
  parent_charge_id, usage_operation_key, kind, model_id, provider_id, byok, input_tokens,
  output_tokens, cached_tokens, duration_ms, tool_calls, credits, estimated_credits, state, basis,
  policy_id, limitations, measurement_source, cached_savings, idempotency_key, reservation_id,
  wallet_entry_id, failure_reason, created_at, settled_at, refunded_at`;

export class PostgresMessageCreditStore implements MessageCreditStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly database: Database) {}

  private get query() {
    return this.database;
  }

  async insertCharge(charge: MessageCharge): Promise<{ charge: MessageCharge; created: boolean }> {
    const owner = requireOwner();
    const inserted = await this.query.query<ChargeRow>(
      `insert into message_charges (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
       on conflict (owner_ref, idempotency_key) do nothing
       returning ${COLUMNS}`,
      [
        owner,
        charge.id,
        charge.workspaceId,
        charge.projectId,
        charge.conversationId,
        charge.runId,
        charge.taskId,
        charge.parentChargeId,
        charge.usageOperationKey,
        charge.kind,
        charge.modelId,
        charge.providerId,
        charge.byok,
        charge.inputTokens,
        charge.outputTokens,
        charge.cachedTokens,
        charge.durationMs,
        charge.toolCalls,
        charge.credits,
        charge.estimatedCredits,
        charge.state,
        charge.basis,
        charge.policyId,
        JSON.stringify(charge.limitations),
        charge.measurementSource,
        charge.cachedSavings,
        charge.idempotencyKey,
        charge.reservationId,
        charge.walletEntryId,
        charge.failureReason,
        charge.createdAt,
        charge.settledAt,
        charge.refundedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { charge: toCharge(row), created: true };
    const existing = await this.findByKey(owner, charge.idempotencyKey);
    if (existing === null) throw new Error('charge insert vanished without a row');
    return { charge: existing, created: false };
  }

  async findByKey(ownerRef: string, idempotencyKey: string): Promise<MessageCharge | null> {
    requireOwner();
    const found = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from message_charges
        where owner_ref = $1 and idempotency_key = $2`,
      [ownerRef, idempotencyKey],
    );
    const row = found.rows[0];
    return row === undefined ? null : toCharge(row);
  }

  async findById(ownerRef: string, chargeId: string): Promise<MessageCharge | null> {
    requireOwner();
    const found = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from message_charges where owner_ref = $1 and id = $2`,
      [ownerRef, chargeId],
    );
    const row = found.rows[0];
    return row === undefined ? null : toCharge(row);
  }

  async saveCharge(charge: MessageCharge, expectedState: MessageCharge['state']): Promise<boolean> {
    const owner = requireOwner();
    const saved = await this.query.query<{ id: string }>(
      `update message_charges
          set input_tokens = $3, output_tokens = $4, cached_tokens = $5, duration_ms = $6,
              tool_calls = $7, credits = $8, estimated_credits = $9, state = $10, basis = $11,
              policy_id = $12, limitations = $13, reservation_id = $14, wallet_entry_id = $15,
              failure_reason = $16, settled_at = $17, refunded_at = $18, run_id = $19,
              conversation_id = $20, project_id = $21, model_id = $22, provider_id = $23,
              workspace_id = $24, usage_operation_key = $25, byok = $26
        where owner_ref = $1 and id = $2 and state = $27
        returning id`,
      [
        owner,
        charge.id,
        charge.inputTokens,
        charge.outputTokens,
        charge.cachedTokens,
        charge.durationMs,
        charge.toolCalls,
        charge.credits,
        charge.estimatedCredits,
        charge.state,
        charge.basis,
        charge.policyId,
        JSON.stringify(charge.limitations),
        charge.reservationId,
        charge.walletEntryId,
        charge.failureReason,
        charge.settledAt,
        charge.refundedAt,
        charge.runId,
        charge.conversationId,
        charge.projectId,
        charge.modelId,
        charge.providerId,
        charge.workspaceId,
        charge.usageOperationKey,
        charge.byok,
        expectedState,
      ],
    );
    return saved.rows.length > 0;
  }

  async listCharges(ownerRef: string, filter: ChargeFilter): Promise<ChargePage> {
    requireOwner();
    const where = `owner_ref = $1
      and ($2::text is null or workspace_id = $2)
      and ($3::text is null or conversation_id = $3)
      and ($4::text is null or project_id = $4)
      and ($5::text is null or run_id = $5)
      and ($6::text is null or kind = $6)
      and ($7::text is null or state = $7)`;
    const params = [
      ownerRef,
      filter.workspaceId ?? null,
      filter.conversationId ?? null,
      filter.projectId ?? null,
      filter.runId ?? null,
      filter.kind ?? null,
      filter.state ?? null,
    ];
    const rows = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from message_charges
        where ${where}
        order by created_at desc, id desc
        limit $8 offset $9`,
      [...params, filter.limit, filter.offset ?? 0],
    );
    const total = await this.query.query<{ total: string }>(
      `select count(*)::text as total from message_charges where ${where}`,
      params,
    );
    return {
      charges: rows.rows.map(toCharge),
      total: Number(total.rows[0]?.total ?? '0'),
    };
  }

  async aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options: { readonly since?: string; readonly workspaceId?: string | null } = {},
  ): Promise<readonly UsageGroup[]> {
    requireOwner();
    const column =
      dimension === 'model'
        ? `coalesce(model_id, 'unreported')`
        : dimension === 'project'
          ? `coalesce(project_id, 'no-project')`
          : dimension === 'conversation'
            ? `coalesce(conversation_id, 'no-conversation')`
            : 'kind';
    const result = await this.query.query<{
      key: string;
      charges: string;
      credits: string;
      input_tokens: string;
      output_tokens: string;
    }>(
      `select ${column} as key,
              count(*)::text as charges,
              coalesce(sum(credits), 0)::text as credits,
              coalesce(sum(input_tokens), 0)::text as input_tokens,
              coalesce(sum(output_tokens), 0)::text as output_tokens
         from message_charges
        where owner_ref = $1
          and state in ('committed', 'exempt')
          and ($2::timestamptz is null or created_at >= $2)
          and ($3::text is null or workspace_id = $3)
        group by 1
        order by 3 desc`,
      [ownerRef, options.since ?? null, options.workspaceId ?? null],
    );
    return result.rows.map((row) => ({
      key: row.key,
      charges: Number(row.charges),
      credits: Number(row.credits),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }));
  }

  async readSettings(
    ownerRef: string,
    workspaceId: string | null,
  ): Promise<SpendingSettings | null> {
    requireOwner();
    const found = await this.query.query<{
      monthly_limit: string | null;
      per_request_limit: string | null;
      updated_at: Date;
    }>(
      `select monthly_limit, per_request_limit, updated_at
         from message_credit_settings where owner_ref = $1 and workspace_id = $2`,
      [ownerRef, workspaceId ?? ''],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    return {
      ownerRef,
      workspaceId,
      monthlyLimit: num(row.monthly_limit),
      perRequestLimit: num(row.per_request_limit),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async saveSettings(settings: SpendingSettings): Promise<SpendingSettings> {
    const owner = requireOwner();
    await this.query.query(
      `insert into message_credit_settings
         (owner_ref, workspace_id, monthly_limit, per_request_limit, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (owner_ref, workspace_id) do update
         set monthly_limit = excluded.monthly_limit,
             per_request_limit = excluded.per_request_limit,
             updated_at = now()`,
      [owner, settings.workspaceId ?? '', settings.monthlyLimit, settings.perRequestLimit],
    );
    return { ...settings, ownerRef: owner };
  }

  async listOpen(ownerRef: string, limit: number): Promise<readonly MessageCharge[]> {
    requireOwner();
    const rows = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from message_charges
        where owner_ref = $1 and state = 'reserved'
        order by created_at asc
        limit $2`,
      [ownerRef, limit],
    );
    return rows.rows.map(toCharge);
  }
}

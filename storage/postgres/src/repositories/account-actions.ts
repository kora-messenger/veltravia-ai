/**
 * The account action trail in PostgreSQL (Step 62).
 *
 * Two tables, two different guarantees:
 *
 *  - `account_action_audit` is append-only. There is no update or delete in this
 *    store, and `(owner_ref, idempotency_key)` is unique, so a retried request
 *    reads its first row instead of writing a second side effect.
 *  - `account_approvals` is consumed by a **conditional update** (`... where
 *    state = 'pending'`), which is what makes a confirmation ticket single-use
 *    even when two requests arrive at the same moment: exactly one update matches
 *    a pending row, and the other sees zero rows and is refused.
 *
 * The confirmation code itself is never stored, only its SHA-256 hash.
 */

import type {
  AccountActionStore,
  AccountApproval,
  AccountActionStatus,
  AccountAuditEntry,
  AccountAuditQuery,
  AccountPermission,
  AccountResourceRef,
  AccountRole,
  RiskLevel,
} from '@veltravia/account-agent-core';

import { assertOwnerMatch } from '../owner-scope.js';
import type { Database, Queryable } from '../pool.js';

interface AuditRow {
  id: string;
  owner_ref: string;
  workspace_id: string | null;
  session_id: string;
  role: AccountRole;
  tool: string;
  risk: number;
  permission: AccountPermission;
  status: AccountActionStatus;
  args_digest: string;
  args: Record<string, unknown>;
  target: AccountResourceRef | null;
  result_summary: string | null;
  changed: AccountResourceRef[];
  failure_code: string | null;
  failure_message: string | null;
  approval_id: string | null;
  execution_id: string | null;
  idempotency_key: string;
  suspicious_arguments: boolean;
  occurred_at: Date;
}

interface ApprovalRow {
  id: string;
  owner_ref: string;
  workspace_id: string | null;
  session_id: string;
  tool: string;
  risk: number;
  args_digest: string;
  args: Record<string, unknown>;
  preview: string;
  state: AccountApproval['state'];
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
}

const AUDIT_COLUMNS = `id, owner_ref, workspace_id, session_id, role, tool, risk, permission, status,
  args_digest, args, target, result_summary, changed, failure_code, failure_message, approval_id,
  execution_id, idempotency_key, suspicious_arguments, occurred_at`;

const APPROVAL_COLUMNS = `id, owner_ref, workspace_id, session_id, tool, risk, args_digest, args,
  preview, state, token_hash, expires_at, created_at, consumed_at`;

const toEntry = (row: AuditRow): AccountAuditEntry => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  sessionId: row.session_id,
  role: row.role,
  tool: row.tool,
  risk: Number(row.risk) as RiskLevel,
  permission: row.permission,
  status: row.status,
  argsDigest: row.args_digest,
  args: row.args ?? {},
  target: row.target,
  resultSummary: row.result_summary,
  changed: Array.isArray(row.changed) ? row.changed : [],
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  approvalId: row.approval_id,
  executionId: row.execution_id,
  idempotencyKey: row.idempotency_key,
  suspiciousArguments: row.suspicious_arguments,
  occurredAt: new Date(row.occurred_at).toISOString(),
});

const toApproval = (row: ApprovalRow): AccountApproval => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  sessionId: row.session_id,
  tool: row.tool,
  risk: Number(row.risk) as RiskLevel,
  argsDigest: row.args_digest,
  args: row.args ?? {},
  preview: row.preview,
  state: row.state,
  tokenHash: row.token_hash,
  expiresAt: new Date(row.expires_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at).toISOString(),
});

export class PostgresAccountActionStore implements AccountActionStore {
  constructor(private readonly database: Database) {}

  async record(entry: AccountAuditEntry): Promise<AccountAuditEntry> {
    assertOwnerMatch(entry.ownerRef);
    const inserted = await this.database.query<AuditRow>(
      `insert into account_action_audit (${AUDIT_COLUMNS})
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)
       on conflict (owner_ref, idempotency_key) do nothing
       returning ${AUDIT_COLUMNS}`,
      [
        entry.id,
        entry.ownerRef,
        entry.workspaceId,
        entry.sessionId,
        entry.role,
        entry.tool,
        entry.risk,
        entry.permission,
        entry.status,
        entry.argsDigest,
        JSON.stringify(entry.args),
        entry.target === null ? null : JSON.stringify(entry.target),
        entry.resultSummary,
        JSON.stringify(entry.changed),
        entry.failureCode,
        entry.failureMessage,
        entry.approvalId,
        entry.executionId,
        entry.idempotencyKey,
        entry.suspiciousArguments,
        entry.occurredAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return toEntry(row);
    // The key is already used by this owner: return the row that exists. A retry
    // must not overwrite the record of what actually happened.
    const existing = await this.byIdempotencyKey(entry.ownerRef, entry.idempotencyKey);
    if (existing !== null) return existing.entry;
    throw new Error('the account action could not be recorded');
  }

  async list(query: AccountAuditQuery): Promise<readonly AccountAuditEntry[]> {
    assertOwnerMatch(query.ownerRef);
    const values: unknown[] = [query.ownerRef];
    const where = ['owner_ref = $1'];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (query.workspaceId != null) add('workspace_id = ?', query.workspaceId);
    if (query.tool != null) add('tool = ?', query.tool);
    if (query.status != null) add('status = ?', query.status);
    values.push(Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50))));
    const rows = await this.database.query<AuditRow>(
      `select ${AUDIT_COLUMNS} from account_action_audit
        where ${where.join(' and ')}
        order by occurred_at desc, id desc
        limit $${values.length}`,
      values,
    );
    return rows.rows.map(toEntry);
  }

  async get(entryId: string): Promise<AccountAuditEntry | null> {
    const rows = await this.database.query<AuditRow>(
      `select ${AUDIT_COLUMNS} from account_action_audit where id = $1`,
      [entryId],
    );
    return rows.rows[0] === undefined ? null : toEntry(rows.rows[0]);
  }

  async byIdempotencyKey(
    ownerRef: string,
    key: string,
  ): Promise<{ readonly entry: AccountAuditEntry } | null> {
    assertOwnerMatch(ownerRef);
    const rows = await this.database.query<AuditRow>(
      `select ${AUDIT_COLUMNS} from account_action_audit
        where owner_ref = $1 and idempotency_key = $2`,
      [ownerRef, key],
    );
    return rows.rows[0] === undefined ? null : { entry: toEntry(rows.rows[0]) };
  }

  async saveApproval(approval: AccountApproval): Promise<AccountApproval> {
    assertOwnerMatch(approval.ownerRef);
    const rows = await this.database.query<ApprovalRow>(
      `insert into account_approvals (${APPROVAL_COLUMNS})
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)
       on conflict (id) do update set state = excluded.state, consumed_at = excluded.consumed_at
       returning ${APPROVAL_COLUMNS}`,
      [
        approval.id,
        approval.ownerRef,
        approval.workspaceId,
        approval.sessionId,
        approval.tool,
        approval.risk,
        approval.argsDigest,
        JSON.stringify(approval.args),
        approval.preview,
        approval.state,
        approval.tokenHash,
        approval.expiresAt,
        approval.createdAt,
        approval.consumedAt,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error('the confirmation could not be saved');
    return toApproval(row);
  }

  async getApproval(approvalId: string): Promise<AccountApproval | null> {
    const rows = await this.database.query<ApprovalRow>(
      `select ${APPROVAL_COLUMNS} from account_approvals where id = $1`,
      [approvalId],
    );
    return rows.rows[0] === undefined ? null : toApproval(rows.rows[0]);
  }

  async consumeApproval(approvalId: string, consumedAt: string): Promise<boolean> {
    const updated = await this.database.query(
      `update account_approvals
          set state = 'consumed', consumed_at = $1
        where id = $2 and state = 'pending' and expires_at > $1`,
      [consumedAt, approvalId],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  /** Test helper: read a pending approval through a transaction-safe path. */
  async pendingCount(tx?: Queryable): Promise<number> {
    const runner = tx ?? this.database;
    const rows = await runner.query<{ count: string }>(
      `select count(*)::text as count from account_approvals where state = 'pending'`,
    );
    return Number(rows.rows[0]?.count ?? 0);
  }
}

/**
 * The account agent's executor (Step 62).
 *
 * One call goes through the same six checks in the same order, whichever model
 * or interface asked for it:
 *
 *   1. the tool exists in the registry;
 *   2. it is available on this deployment;
 *   3. the arguments validate, and no argument tries to name an identity;
 *   4. the caller's role satisfies the tool's permission, and a risk-4 tool also
 *      requires the owner;
 *   5. a caller that reused an idempotency key gets the recorded answer instead
 *      of a second side effect;
 *   6. a risk-3 or risk-4 tool needs a confirmation ticket that matches the tool
 *      and the exact arguments, is still pending, and has not expired.
 *
 * Every attempt is written to the audit trail, including the refusals: an action
 * the assistant suggested and one it was not allowed to take are different rows,
 * and neither is reported as done.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AccountToolRegistry } from './registry.js';
import {
  ACCOUNT_AGENT_LIMITS,
  AccountAgentError,
  PERMISSION_MINIMUM_ROLE,
  ROLE_RANK,
  requiresApproval,
  type AccountActionStore,
  type AccountActionStatus,
  type AccountApproval,
  type AccountAuditEntry,
  type AccountAuditQuery,
  type AccountPermission,
  type AccountPrincipal,
  type AccountResourceRef,
  type AccountTool,
  type AccountToolDefinition,
  type AccountToolResult,
  type RiskLevel,
} from './types.js';
import { digestArguments, redactArguments, validateArguments } from './validate.js';

export interface AccountCallRequest {
  readonly tool: string;
  readonly args?: unknown;
  /** Supplied by the caller so a retried request cannot double its side effect. */
  readonly idempotencyKey?: string | null;
  /** The `id.secret` ticket a person was given when the action was prepared. */
  readonly approvalToken?: string | null;
  /** Correlates the action with a run or execution, when there is one. */
  readonly executionId?: string | null;
  /**
   * A human decision already taken outside this surface.
   *
   * The chat collects its own confirmation before a risky tool runs, bound to
   * the exact input by the tool system. When a call arrives from there, that
   * confirmation IS the person's answer, so it is recorded as the approval
   * instead of asking for a second one in a different window. Only an internal
   * caller may pass this: no HTTP body is ever read for it.
   */
  readonly grant?: AccountPlatformGrant | null;
}

/** A confirmation a person gave elsewhere in the product, named for the audit. */
export interface AccountPlatformGrant {
  /** Only the chat's tool confirmation exists today; anything else is refused. */
  readonly kind: 'tool_confirmation';
  /** Id of the confirmation the person approved. Recorded on the audit row. */
  readonly reference: string;
}

export interface AccountApprovalTicket {
  readonly approvalId: string;
  /** Returned once. Only its hash is stored. */
  readonly token: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly preview: string;
  readonly argsDigest: string;
  readonly expiresAt: string;
}

export type AccountCallStatus =
  'executed' | 'replayed' | 'awaiting_confirmation' | 'refused' | 'failed';

export interface AccountCallOutcome {
  readonly status: AccountCallStatus;
  readonly result: AccountToolResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly approval: AccountApprovalTicket | null;
  readonly audit: AccountAuditEntry;
}

export interface AccountAgentOptions {
  readonly registry: AccountToolRegistry;
  readonly store: AccountActionStore;
  readonly now?: (() => Date) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly approvalTtlMs?: number | undefined;
}

const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** A one-line, human preview of an action, built from declared fields only. */
export function previewOf(
  definition: AccountToolDefinition,
  args: Readonly<Record<string, unknown>>,
): string {
  const parts = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => {
      const shown = Array.isArray(value) ? value.join(', ') : String(value);
      return `${key}: ${shown.length > 80 ? `${shown.slice(0, 77)}…` : shown}`;
    });
  const suffix = parts.length === 0 ? 'with no further detail' : `(${parts.join('; ')})`;
  return `${definition.title} ${suffix}`;
}

export class AccountAgent {
  private readonly registry: AccountToolRegistry;
  private readonly store: AccountActionStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ttl: number;

  constructor(options: AccountAgentOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `act_${randomUUID()}`);
    this.ttl = options.approvalTtlMs ?? ACCOUNT_AGENT_LIMITS.approvalTtlMs;
  }

  catalog(): readonly AccountToolDefinition[] {
    return this.registry.catalog();
  }

  /** The permissions a caller holds, so an interface can grey out what it cannot do. */
  permissionsFor(principal: AccountPrincipal): readonly AccountPermission[] {
    return (Object.keys(PERMISSION_MINIMUM_ROLE) as AccountPermission[]).filter((permission) =>
      this.holds(principal, permission),
    );
  }

  private holds(principal: AccountPrincipal, permission: AccountPermission): boolean {
    if (principal.operator) return true;
    const minimum = PERMISSION_MINIMUM_ROLE[permission];
    return ROLE_RANK[principal.role] >= ROLE_RANK[minimum];
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private auditEntry(
    principal: AccountPrincipal,
    definition: AccountToolDefinition | null,
    input: {
      readonly status: AccountActionStatus;
      readonly args: Readonly<Record<string, unknown>>;
      readonly digest: string;
      readonly suspicious: boolean;
      readonly idempotencyKey: string;
      readonly summary?: string | null;
      readonly changed?: readonly AccountResourceRef[];
      readonly failure?: { readonly code: string; readonly message: string } | null;
      readonly approvalId?: string | null;
      readonly executionId?: string | null;
      readonly fallbackTool?: string;
      readonly fallbackRisk?: RiskLevel;
      readonly fallbackPermission?: AccountPermission;
    },
  ): AccountAuditEntry {
    return {
      id: this.newId(),
      ownerRef: principal.ownerRef,
      workspaceId: principal.workspaceId,
      sessionId: principal.sessionId,
      role: principal.role,
      tool: definition?.name ?? input.fallbackTool ?? 'unknown',
      risk: definition?.risk ?? input.fallbackRisk ?? 1,
      permission: definition?.permission ?? input.fallbackPermission ?? 'account:read',
      status: input.status,
      argsDigest: input.digest,
      args: redactArguments(input.args),
      target: input.changed?.[0] ?? null,
      resultSummary: input.summary ?? null,
      changed: input.changed ?? [],
      failureCode: input.failure?.code ?? null,
      failureMessage: input.failure?.message ?? null,
      approvalId: input.approvalId ?? null,
      executionId: input.executionId ?? null,
      idempotencyKey: input.idempotencyKey,
      suspiciousArguments: input.suspicious,
      occurredAt: this.stamp(),
    };
  }

  private async refuse(
    principal: AccountPrincipal,
    definition: AccountToolDefinition | null,
    input: {
      readonly code: string;
      readonly message: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly digest: string;
      readonly suspicious: boolean;
      readonly idempotencyKey: string;
      readonly approvalId?: string | null;
      readonly executionId?: string | null;
      readonly fallbackTool?: string;
      readonly fallbackRisk?: RiskLevel;
      readonly fallbackPermission?: AccountPermission;
    },
  ): Promise<AccountCallOutcome> {
    const audit = await this.store.record(
      this.auditEntry(principal, definition, {
        ...input,
        status: 'refused',
        failure: { code: input.code, message: input.message },
        approvalId: input.approvalId,
      }),
    );
    return {
      status: 'refused',
      result: null,
      error: { code: input.code, message: input.message },
      approval: null,
      audit,
    };
  }

  async call(
    principal: AccountPrincipal,
    request: AccountCallRequest,
  ): Promise<AccountCallOutcome> {
    const toolName = typeof request.tool === 'string' ? request.tool.trim() : '';
    const rawArgs = request.args ?? {};
    const digest = digestArguments(rawArgs);
    const idempotencyKey = clean(request.idempotencyKey) ?? `auto_${this.newId()}`;

    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
      return this.refuse(principal, null, {
        code: 'INVALID_ARGUMENTS',
        message: 'An idempotency key must be 8-120 characters of letters, digits, ":" or "-".',
        args: {},
        digest,
        suspicious: false,
        idempotencyKey: `invalid:${this.newId()}`,
        fallbackTool: toolName === '' ? 'unknown' : toolName,
      });
    }

    const tool = this.registry.get(toolName);
    if (tool === undefined) {
      return this.refuse(principal, null, {
        code: 'UNKNOWN_TOOL',
        message: `"${toolName}" is not an account operation this agent can perform.`,
        args: {},
        digest,
        suspicious: false,
        idempotencyKey,
        fallbackTool: toolName === '' ? 'unknown' : toolName,
      });
    }
    const definition = tool.definition;

    if (!definition.availability.available) {
      return this.refuse(principal, definition, {
        code: 'TOOL_NOT_AVAILABLE',
        message:
          definition.availability.reason ?? 'That operation is not available on this deployment.',
        args: {},
        digest,
        suspicious: false,
        idempotencyKey,
      });
    }

    let args: Readonly<Record<string, unknown>>;
    let suspicious: boolean;
    try {
      const validated = validateArguments(definition, rawArgs);
      args = validated.args;
      suspicious = validated.suspicious;
    } catch (error) {
      const refusal = error as AccountAgentError;
      return this.refuse(principal, definition, {
        code: refusal.code ?? 'INVALID_ARGUMENTS',
        message: refusal.message,
        args: {},
        digest,
        suspicious: false,
        idempotencyKey,
      });
    }

    if (definition.needsWorkspace && principal.workspaceId === null) {
      return this.refuse(principal, definition, {
        code: 'WORKSPACE_REQUIRED',
        message: 'Choose a workspace first; that operation works on a workspace.',
        args,
        digest,
        suspicious,
        idempotencyKey,
      });
    }

    if (!this.holds(principal, definition.permission)) {
      return this.refuse(principal, definition, {
        code: 'PERMISSION_DENIED',
        message: `That needs ${definition.permission.replace(':', ' ')} permission, which this account does not hold.`,
        args,
        digest,
        suspicious,
        idempotencyKey,
      });
    }
    if (definition.risk === 4 && principal.role !== 'owner' && !principal.operator) {
      return this.refuse(principal, definition, {
        code: 'PERMISSION_DENIED',
        message: 'A high-impact action needs the workspace owner.',
        args,
        digest,
        suspicious,
        idempotencyKey,
      });
    }

    const previous = await this.store.byIdempotencyKey(principal.ownerRef, idempotencyKey);
    // Only a *finished* attempt replays. A prepared-but-unconfirmed action must
    // still be confirmable under the same key, and a refusal is retryable.
    const settled =
      previous !== null &&
      (previous.entry.status === 'executed' || previous.entry.status === 'failed');
    if (settled && previous !== null && previous.entry.tool === definition.name) {
      // A retry finds the recorded answer. It does not run the tool again and it
      // does not rewrite the audit row, because the first attempt is the truth.
      const replayed = previous.entry;
      return {
        status: 'replayed',
        result:
          previous.entry.resultSummary === null
            ? null
            : {
                ok: previous.entry.failureCode === null,
                summary: previous.entry.resultSummary,
                changed: previous.entry.changed,
                ...(previous.entry.failureCode === null
                  ? {}
                  : {
                      failure: {
                        code: previous.entry.failureCode,
                        message: previous.entry.failureMessage ?? '',
                      },
                    }),
              },
        error: null,
        approval: null,
        audit: replayed,
      };
    }

    // ---- approval gate ------------------------------------------------------
    if (requiresApproval(definition.risk)) {
      const grant = request.grant ?? null;
      if (grant !== null) {
        // A confirmation from another surface is honoured only when it names a
        // confirmation and is shaped like one. A malformed or unknown grant is a
        // refusal, never a quiet downgrade to "please confirm".
        const reference = typeof grant.reference === 'string' ? grant.reference.trim() : '';
        if (grant.kind !== 'tool_confirmation' || !/^[A-Za-z0-9:_-]{8,120}$/.test(reference)) {
          return this.refuse(principal, definition, {
            code: 'APPROVAL_INVALID',
            message: 'That confirmation cannot be used for this action.',
            args,
            digest,
            suspicious,
            idempotencyKey,
          });
        }
        return this.execute(principal, tool, {
          args,
          digest,
          suspicious,
          idempotencyKey,
          approvalId: reference,
          executionId: request.executionId ?? null,
        });
      }
      const token = clean(request.approvalToken);
      if (token === null) {
        const approval = await this.prepareApproval(principal, definition, args, digest);
        const audit = await this.store.record(
          this.auditEntry(principal, definition, {
            status: 'awaiting_confirmation',
            args,
            digest,
            suspicious,
            idempotencyKey,
            approvalId: approval.id,
            summary: approval.preview,
            executionId: request.executionId ?? null,
          }),
        );
        return {
          status: 'awaiting_confirmation',
          result: null,
          error: null,
          approval: {
            approvalId: approval.id,
            token: `${approval.id}.${approval.secret}`,
            tool: definition.name,
            risk: definition.risk,
            preview: approval.preview,
            argsDigest: digest,
            expiresAt: approval.expiresAt,
          },
          audit,
        };
      }

      const consumed = await this.consumeTicket(
        principal,
        definition,
        { args, digest, suspicious, idempotencyKey },
        token,
        request.executionId ?? null,
      );
      if ('outcome' in consumed) return consumed.outcome;
      return this.execute(principal, tool, {
        args,
        digest,
        suspicious,
        idempotencyKey,
        approvalId: consumed.approvalId,
        executionId: request.executionId ?? null,
      });
    }

    return this.execute(principal, tool, {
      args,
      digest,
      suspicious,
      idempotencyKey,
      approvalId: null,
      executionId: request.executionId ?? null,
    });
  }

  private async execute(
    principal: AccountPrincipal,
    tool: AccountTool,
    input: {
      readonly args: Readonly<Record<string, unknown>>;
      readonly digest: string;
      readonly suspicious: boolean;
      readonly idempotencyKey: string;
      readonly approvalId: string | null;
      readonly executionId: string | null;
    },
  ): Promise<AccountCallOutcome> {
    const definition = tool.definition;
    try {
      const result = await tool.invoke({
        principal,
        args: input.args,
        idempotencyKey: input.idempotencyKey,
        now: this.stamp(),
        workspaceId: principal.workspaceId,
      });
      const status: AccountActionStatus = result.ok ? 'executed' : 'failed';
      const audit = await this.store.record(
        this.auditEntry(principal, definition, {
          status,
          args: input.args,
          digest: input.digest,
          suspicious: input.suspicious,
          idempotencyKey: input.idempotencyKey,
          summary: result.summary,
          changed: result.changed ?? [],
          failure: result.failure ?? null,
          approvalId: input.approvalId,
          executionId: input.executionId,
        }),
      );
      return {
        status: result.ok ? 'executed' : 'failed',
        result,
        error: result.failure ?? null,
        approval: null,
        audit,
      };
    } catch (error) {
      const known = error instanceof AccountAgentError ? error : null;
      const failure = {
        code: known?.code ?? 'TOOL_FAILED',
        message: known?.message ?? 'The operation failed and nothing was recorded as done.',
      };
      const audit = await this.store.record(
        this.auditEntry(principal, definition, {
          status: 'failed',
          args: input.args,
          digest: input.digest,
          suspicious: input.suspicious,
          idempotencyKey: input.idempotencyKey,
          summary: null,
          failure,
          approvalId: input.approvalId,
          executionId: input.executionId,
        }),
      );
      return { status: 'failed', result: null, error: failure, approval: null, audit };
    }
  }

  private async prepareApproval(
    principal: AccountPrincipal,
    definition: AccountToolDefinition,
    args: Readonly<Record<string, unknown>>,
    digest: string,
  ): Promise<AccountApproval & { readonly secret: string }> {
    const secret = randomBytes(24).toString('hex');
    const approval: AccountApproval = {
      id: `apr_${randomUUID()}`,
      ownerRef: principal.ownerRef,
      workspaceId: principal.workspaceId,
      sessionId: principal.sessionId,
      tool: definition.name,
      risk: definition.risk,
      argsDigest: digest,
      args: redactArguments(args),
      preview: previewOf(definition, args),
      state: 'pending',
      tokenHash: createHash('sha256').update(secret).digest('hex'),
      expiresAt: new Date(this.now().getTime() + this.ttl).toISOString(),
      createdAt: this.stamp(),
      consumedAt: null,
    };
    const saved = await this.store.saveApproval(approval);
    // The token is handed to the caller once; only the hash is stored.
    return Object.assign(saved, { secret });
  }

  private async consumeTicket(
    principal: AccountPrincipal,
    definition: AccountToolDefinition,
    input: {
      readonly args: Readonly<Record<string, unknown>>;
      readonly digest: string;
      readonly suspicious: boolean;
      readonly idempotencyKey: string;
    },
    token: string,
    executionId: string | null,
  ): Promise<{ outcome: AccountCallOutcome } | { approvalId: string }> {
    const separator = token.lastIndexOf('.');
    const approvalId = separator === -1 ? token : token.slice(0, separator);
    const secret = separator === -1 ? '' : token.slice(separator + 1);
    const approval = await this.store.getApproval(approvalId);
    const refuse = async (
      code: string,
      message: string,
    ): Promise<{ outcome: AccountCallOutcome }> => ({
      outcome: await this.refuse(principal, definition, {
        code,
        message,
        args: input.args,
        digest: input.digest,
        suspicious: input.suspicious,
        idempotencyKey: input.idempotencyKey,
        approvalId,
        executionId,
      }),
    });
    if (approval === null || approval.ownerRef !== principal.ownerRef) {
      return refuse('APPROVAL_INVALID', 'That confirmation does not match this account.');
    }
    if (approval.tool !== definition.name || approval.argsDigest !== input.digest) {
      return refuse(
        'APPROVAL_INVALID',
        'That confirmation was for a different action. Prepare it again so the details match.',
      );
    }
    if (approval.state !== 'pending') {
      return refuse('APPROVAL_INVALID', 'That confirmation was already used.');
    }
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      return refuse('APPROVAL_EXPIRED', 'That confirmation expired. Prepare the action again.');
    }
    if (
      secret.length === 0 ||
      createHash('sha256').update(secret).digest('hex') !== approval.tokenHash
    ) {
      return refuse('APPROVAL_INVALID', 'That confirmation code is not correct.');
    }
    const won = await this.store.consumeApproval(approval.id, this.stamp());
    if (!won) {
      return refuse('APPROVAL_INVALID', 'That confirmation was already used.');
    }
    return { approvalId: approval.id };
  }

  async history(
    principal: AccountPrincipal,
    query: Omit<AccountAuditQuery, 'ownerRef'> = {},
  ): Promise<readonly AccountAuditEntry[]> {
    return this.store.list({
      ownerRef: principal.ownerRef,
      ...(principal.workspaceId === null ? {} : { workspaceId: principal.workspaceId }),
      ...(query.tool === undefined ? {} : { tool: query.tool }),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: Math.min(query.limit ?? 50, ACCOUNT_AGENT_LIMITS.maxAuditPageSize),
    });
  }

  async entry(principal: AccountPrincipal, entryId: string): Promise<AccountAuditEntry | null> {
    const entry = await this.store.get(entryId);
    return entry !== null && entry.ownerRef === principal.ownerRef ? entry : null;
  }
}

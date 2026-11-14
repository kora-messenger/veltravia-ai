/**
 * The Personal Account Agent's contract (Step 62).
 *
 * The agent is a **registry of declared operations**, not a database client and
 * not a shell. Every capability is one entry in that registry, with a fixed
 * parameter list, a required permission, and a risk level that decides whether
 * the operation runs straight away or waits for the person to approve it.
 *
 * The security boundary is structural, and everything else here depends on it:
 *
 *  - identity comes from `AccountPrincipal`, which the server builds from the
 *    authenticated request. No tool parameter names an owner, a role or a
 *    session, and an argument that tries to is refused rather than ignored;
 *  - a tool can only reach the ports it was constructed with, so there is no
 *    arbitrary SQL, no arbitrary path, and no credential in the agent's hands;
 *  - the risk level of a declared tool is checked before the tool runs, so a
 *    model cannot promote its own permission by asking more confidently.
 */

export type AccountRole = 'member' | 'admin' | 'owner';

export interface AccountPrincipal {
  /** The authenticated account. Never supplied by the model. */
  readonly ownerRef: string;
  /** The session that authenticated, recorded on every action. */
  readonly sessionId: string;
  readonly role: AccountRole;
  /** The workspace this request is scoped to, when the surface has one. */
  readonly workspaceId: string | null;
  /** True only for the deployment's operator token, never for a customer request. */
  readonly operator: boolean;
}

/** Least privilege, in four steps. A tool declares exactly one. */
export type AccountPermission =
  'account:read' | 'account:write' | 'workspace:admin' | 'workspace:owner';

export const PERMISSION_LABELS: Readonly<Record<AccountPermission, string>> = {
  'account:read': 'Read the signed-in account',
  'account:write': 'Change the signed-in account’s own resources',
  'workspace:admin': 'Administer the workspace',
  'workspace:owner': 'Act as the workspace owner',
};

export const ROLES: readonly AccountRole[] = ['member', 'admin', 'owner'];

/** Role ranking used for permission checks. Owner is the highest. */
export const ROLE_RANK: Readonly<Record<AccountRole, number>> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export const PERMISSION_MINIMUM_ROLE: Readonly<Record<AccountPermission, AccountRole>> = {
  'account:read': 'member',
  'account:write': 'member',
  'workspace:admin': 'admin',
  'workspace:owner': 'owner',
};

/**
 * 1 read-only, 2 reversible, 3 sensitive, 4 high-impact or irreversible.
 * The numbers are the whole approval policy: 1 and 2 run, 3 and 4 wait.
 */
export type RiskLevel = 1 | 2 | 3 | 4;

export const RISK_LABELS: Readonly<Record<RiskLevel, string>> = {
  1: 'Read only',
  2: 'Reversible change',
  3: 'Sensitive action: confirmation required',
  4: 'High impact: confirmation and owner authorization required',
};

export function requiresApproval(risk: RiskLevel): boolean {
  return risk >= 3;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | 'string_list';

export interface ParamSpec {
  readonly name: string;
  readonly type: ParamType;
  readonly required?: boolean;
  /** Allowed values for `enum`. */
  readonly values?: readonly string[];
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Whole numbers only (credit amounts allow fractions, counts do not). */
  readonly integer?: boolean;
  readonly description?: string;
}

export interface ToolAvailability {
  readonly available: boolean;
  /** Required when unavailable: what a person would need for it to exist. */
  readonly reason?: string;
}

export interface AccountToolDefinition {
  readonly name: string;
  readonly title: string;
  /** One sentence, in the product's voice: what it does, not how. */
  readonly summary: string;
  readonly risk: RiskLevel;
  readonly permission: AccountPermission;
  readonly params: readonly ParamSpec[];
  readonly mutates: boolean;
  readonly availability: ToolAvailability;
  /** True when the tool cannot be called without a workspace in scope. */
  readonly needsWorkspace: boolean;
}

export interface AccountResourceRef {
  readonly resource: string;
  readonly id: string;
  readonly location?: string;
}

export interface AccountToolResult {
  readonly ok: boolean;
  /** What happened, in one plain sentence. Shown to the person. */
  readonly summary: string;
  /** Structured detail for the interface. Never a secret, never a raw record dump. */
  readonly data?: unknown;
  readonly changed?: readonly AccountResourceRef[];
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface AccountToolContext {
  readonly principal: AccountPrincipal;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly now: string;
  /** The workspace in scope: the principal's, or the one validated for this call. */
  readonly workspaceId: string | null;
}

export interface AccountTool {
  readonly definition: AccountToolDefinition;
  invoke(context: AccountToolContext): Promise<AccountToolResult>;
}

export type AccountActionStatus =
  'suggested' | 'awaiting_confirmation' | 'executed' | 'failed' | 'refused' | 'replayed';

export interface AccountAuditEntry {
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly sessionId: string;
  readonly role: AccountRole;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly permission: AccountPermission;
  readonly status: AccountActionStatus;
  /** SHA-256 of the canonical argument JSON: what was asked, verifiably. */
  readonly argsDigest: string;
  /** The arguments as stored: redacted, never a credential. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly target: AccountResourceRef | null;
  readonly resultSummary: string | null;
  readonly changed: readonly AccountResourceRef[];
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly approvalId: string | null;
  readonly executionId: string | null;
  readonly idempotencyKey: string;
  /** True when the arguments carried language that looked like an instruction. */
  readonly suspiciousArguments: boolean;
  readonly occurredAt: string;
}

export interface AccountApproval {
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly sessionId: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly argsDigest: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** What will change, in the person's words, shown before they approve. */
  readonly preview: string;
  readonly state: 'pending' | 'consumed' | 'expired';
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

export interface AccountAuditQuery {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly tool?: string | null;
  readonly status?: AccountActionStatus | null;
  readonly limit?: number | null;
}

export interface AccountActionStore {
  record(entry: AccountAuditEntry): Promise<AccountAuditEntry>;
  list(query: AccountAuditQuery): Promise<readonly AccountAuditEntry[]>;
  get(entryId: string): Promise<AccountAuditEntry | null>;
  /** The recorded result of an idempotency key, if this owner already used it. */
  byIdempotencyKey(
    ownerRef: string,
    key: string,
  ): Promise<{ readonly entry: AccountAuditEntry } | null>;
  saveApproval(approval: AccountApproval): Promise<AccountApproval>;
  getApproval(approvalId: string): Promise<AccountApproval | null>;
  /** Single use: true only for the one caller that consumed a pending approval. */
  consumeApproval(approvalId: string, consumedAt: string): Promise<boolean>;
}

export const ACCOUNT_AGENT_LIMITS = {
  maxArgsBytes: 4_096,
  maxStringLength: 512,
  maxStringListItems: 50,
  maxAuditPageSize: 100,
  approvalTtlMs: 10 * 60_000,
  maxTools: 64,
} as const;

export type AccountAgentErrorCode =
  | 'UNKNOWN_TOOL'
  | 'TOOL_NOT_AVAILABLE'
  | 'PERMISSION_DENIED'
  | 'IDENTITY_IN_ARGUMENTS'
  | 'INVALID_ARGUMENTS'
  | 'ARGUMENT_REJECTED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'WORKSPACE_REQUIRED'
  | 'TOOL_FAILED';

export class AccountAgentError extends Error {
  constructor(
    readonly code: AccountAgentErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AccountAgentError';
  }
}

/** Argument names that would let a caller speak for someone else. */
export const FORBIDDEN_ARGUMENT_NAMES: readonly string[] = [
  'ownerref',
  'owner',
  'owner_ref',
  'userid',
  'user_id',
  'accountid',
  'account_id',
  'sessionid',
  'session_id',
  'role',
  'permission',
  'permissions',
  'operator',
  'isadmin',
  'is_admin',
  'actingas',
  'acting_as',
  'impersonate',
];

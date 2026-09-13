/**
 * Provider-neutral permission/scope system.
 *
 * Two layers, deliberately separated:
 *
 * 1. DECLARED permissions - the catalog a connector publishes ("I could use
 *    repositories.read, repositories.write"). Declaring is free.
 * 2. GRANTED permissions - what the operator has actually allowed for this
 *    connector, held by the ConnectorManager. Granting is explicit and starts
 *    EMPTY: registering a connector never grants anything (security rule).
 *
 * Every permission carries a risk level so future approval gates can require
 * human confirmation for high/critical actions automatically.
 */

export type PermissionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const PERMISSION_RISK_LEVELS: readonly PermissionRiskLevel[] = [
  'low',
  'medium',
  'high',
  'critical',
];

export function isPermissionRiskLevel(value: unknown): value is PermissionRiskLevel {
  return typeof value === 'string' && (PERMISSION_RISK_LEVELS as readonly string[]).includes(value);
}

/** A single declared permission - metadata only, never a secret. */
export interface Permission {
  /**
   * Stable permission id, namespaced by the connector author using dot
   * notation, e.g. "repositories.read". Generic here: any scheme works.
   */
  readonly id: string;
  /** What this permission allows, in plain language. */
  readonly description: string;
  /** How dangerous granting this permission is. */
  readonly riskLevel: PermissionRiskLevel;
}

const PERMISSION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Defines a permission with validation - the only supported constructor. */
export function definePermission(
  id: string,
  description: string,
  riskLevel: PermissionRiskLevel,
): Permission {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new Error('Permission id must be a non-empty string of at most 128 characters.');
  }
  if (!PERMISSION_ID_PATTERN.test(id)) {
    throw new Error(
      `Permission id "${id}" must be lowercase dot/dash/underscore-separated segments.`,
    );
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`Permission "${id}" must have a non-empty description.`);
  }
  if (!isPermissionRiskLevel(riskLevel)) {
    throw new Error(`Permission "${id}" has an unknown risk level.`);
  }
  return { id, description, riskLevel };
}

/**
 * An immutable set of granted permission ids.
 * New sets are derived via `with()`; nothing is ever auto-included.
 */
export class PermissionSet {
  private readonly ids: ReadonlySet<string>;

  private constructor(ids: ReadonlySet<string>) {
    this.ids = ids;
  }

  static empty(): PermissionSet {
    return new PermissionSet(new Set());
  }

  /** Derives a new set that additionally includes the given permission ids. */
  with(...permissionIds: readonly string[]): PermissionSet {
    const next = new Set(this.ids);
    for (const id of permissionIds) next.add(id);
    return new PermissionSet(next);
  }

  /** Derives a new set without the given permission ids. */
  without(...permissionIds: readonly string[]): PermissionSet {
    const next = new Set(this.ids);
    for (const id of permissionIds) next.delete(id);
    return new PermissionSet(next);
  }

  has(permissionId: string): boolean {
    return this.ids.has(permissionId);
  }

  /** True only if every given permission id is present. */
  hasAll(permissionIds: readonly string[]): boolean {
    return permissionIds.every((id) => this.ids.has(id));
  }

  get size(): number {
    return this.ids.size;
  }

  list(): readonly string[] {
    return [...this.ids].sort();
  }
}

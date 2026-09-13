/**
 * Generic operation/action abstraction.
 *
 * A ConnectorOperation DESCRIBES something a connector can do - its id, the
 * permissions it requires, its input/output shapes, and whether it needs
 * explicit user confirmation. It is a declaration, not an executor: the
 * connector core does NOT run operations. Execution arrives with the future
 * Tool/Function System (Step 5), which will route through the Connector
 * Manager's permission gate and (for high-risk operations) the approval flow.
 *
 * Example (architectural only - NOT a real GitHub operation):
 *
 *   {
 *     id: "example.read",
 *     name: "Read Resource",
 *     description: "Reads a resource",
 *     requiredPermissions: ["read"],
 *     requiresConfirmation: false,
 *   }
 */

/** Loose JSON-Schema-like shape - the core only stores and serves it. */
export type JsonSchemaLike = Readonly<Record<string, unknown>>;

/** A declared, permission-gated operation a connector supports. */
export interface ConnectorOperation {
  /** Unique within the connector, dot/dash separated (e.g. "example.read"). */
  readonly id: string;
  /** Human display name. */
  readonly name: string;
  /** What this operation does, in plain language. */
  readonly description: string;
  /** Permission ids (declared by the same connector) required to run it. */
  readonly requiredPermissions: readonly string[];
  /** Optional JSON-schema-like description of the operation input. */
  readonly inputSchema?: JsonSchemaLike;
  /** Optional JSON-schema-like description of the operation output. */
  readonly outputSchema?: JsonSchemaLike;
  /**
   * Whether a human must explicitly confirm each run (approval gate).
   * The effective requirement can only ever be RAISED by risk level - see
   * {@link operationRequiresConfirmation}.
   */
  readonly requiresConfirmation: boolean;
}

const OPERATION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Defines a validated operation declaration. */
export function defineOperation(input: ConnectorOperation): ConnectorOperation {
  const reasons: string[] = [];
  if (
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 128 ||
    !OPERATION_ID_PATTERN.test(input.id)
  ) {
    reasons.push(
      `operation id "${String(input.id)}" must be lowercase dot/dash-separated segments`,
    );
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    reasons.push(`operation ${input.id} must have a non-empty name`);
  }
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    reasons.push(`operation ${input.id} must have a non-empty description`);
  }
  if (
    !Array.isArray(input.requiredPermissions) ||
    input.requiredPermissions.length === 0 ||
    input.requiredPermissions.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    reasons.push(`operation ${input.id} must list at least one required permission id`);
  }
  if (typeof input.requiresConfirmation !== 'boolean') {
    reasons.push(`operation ${input.id} must state requiresConfirmation explicitly`);
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid operation: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    requiredPermissions: [...input.requiredPermissions],
    ...(input.inputSchema !== undefined ? { inputSchema: input.inputSchema } : {}),
    ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
    requiresConfirmation: input.requiresConfirmation,
  };
}

/**
 * Effective confirmation requirement: an operation's explicit flag can only
 * RAISE the bar. If any required permission is high or critical risk, human
 * confirmation is mandatory regardless of what the operation says.
 */
export function operationRequiresConfirmation(
  operation: ConnectorOperation,
  declaredPermissions: readonly { readonly id: string; readonly riskLevel: string }[],
): boolean {
  if (operation.requiresConfirmation) return true;
  return operation.requiredPermissions.some((requiredId) =>
    declaredPermissions.some(
      (permission) =>
        permission.id === requiredId &&
        (permission.riskLevel === 'high' || permission.riskLevel === 'critical'),
    ),
  );
}

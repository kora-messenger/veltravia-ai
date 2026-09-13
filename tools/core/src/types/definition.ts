import type { PermissionRiskLevel } from '@veltravia/connector-core';
import { isPermissionRiskLevel } from '@veltravia/connector-core';

import { isToolCategory, type ToolCategory } from './category.js';
import type { ToolObjectSchema } from '../validation/schema.js';

/**
 * Optional reference from a tool to a connector operation.
 *
 * A tool that references a connector operation NEVER executes it directly -
 * the Tool System routes the request through the ConnectorManager's
 * permission gate (Step 4). The reference is pure data; no connector SDK is
 * imported, no credential is touched, and no external service is called by
 * this package.
 */
export interface ConnectorOperationReference {
  /** Id of the registered connector that owns the operation (e.g. "mock"). */
  readonly connectorId: string;
  /** Id of the operation the connector declares (e.g. "mock.read"). */
  readonly operationId: string;
}

/**
 * A strongly typed tool definition - the DECLARATION of a controlled
 * operation. Pure metadata: it carries no behavior, no credentials, and no
 * executable code. Registration grants nothing; execution is a separate,
 * gated pipeline (executor/).
 */
export interface ToolDefinition {
  /** Unique, stable, machine-friendly id (dot-separated lowercase, e.g. "mock.summarize"). */
  readonly id: string;
  /** Human display name. */
  readonly name: string;
  /** What this tool does, in one or two sentences. */
  readonly description: string;
  /** Tool version (semver). */
  readonly version: string;
  /** Provider-neutral category. */
  readonly category: ToolCategory;
  /** Schema of the input the tool accepts - validated before any execution. */
  readonly inputSchema: ToolObjectSchema;
  /** Schema of the normalized output the tool produces - validated after execution. */
  readonly outputSchema: ToolObjectSchema;
  /**
   * Permission ids required to invoke this tool. Grants are explicit and
   * separate: registering a tool NEVER grants these.
   */
  readonly requiredPermissions: readonly string[];
  /** Optional connector operation this tool routes through (never executed directly). */
  readonly connector?: ConnectorOperationReference;
  /** How dangerous invoking this tool is. */
  readonly riskLevel: PermissionRiskLevel;
  /**
   * Whether each invocation needs explicit human confirmation. The flag can
   * only RAISE the bar: high/critical-risk tools require confirmation
   * regardless of what this says (see effectiveConfirmationRequirement()).
   */
  readonly requiresConfirmation: boolean;
}

const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PERMISSION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Effective confirmation requirement: an explicit flag can only raise the
 * bar. High or critical risk forces confirmation even when the definition
 * says otherwise. The system never assumes a risky action is safe.
 */
export function effectiveConfirmationRequirement(tool: ToolDefinition): boolean {
  if (tool.requiresConfirmation) return true;
  return tool.riskLevel === 'high' || tool.riskLevel === 'critical';
}

/** Validates and creates a tool definition. Throws on structural problems. */
export function defineTool(input: ToolDefinition): ToolDefinition {
  const reasons: string[] = [];
  if (
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 128 ||
    !TOOL_ID_PATTERN.test(input.id)
  ) {
    reasons.push(
      `id "${String(input.id)}" must be lowercase dot/dash-separated segments (max 128 chars)`,
    );
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    reasons.push('name must be a non-empty string');
  }
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    reasons.push('description must be a non-empty string');
  }
  if (typeof input.version !== 'string' || !SEMVER_PATTERN.test(input.version)) {
    reasons.push('version must be semver (e.g. "1.0.0")');
  }
  if (!isToolCategory(input.category)) {
    reasons.push('category is unknown');
  }
  if (!Array.isArray(input.requiredPermissions) || input.requiredPermissions.length === 0) {
    reasons.push('requiredPermissions must declare at least one permission id');
  } else {
    for (const permissionId of input.requiredPermissions) {
      if (typeof permissionId !== 'string' || !PERMISSION_ID_PATTERN.test(permissionId)) {
        reasons.push(`required permission "${String(permissionId)}" is not a valid permission id`);
      }
    }
  }
  if (!isPermissionRiskLevel(input.riskLevel)) {
    reasons.push('riskLevel is unknown');
  }
  if (typeof input.requiresConfirmation !== 'boolean') {
    reasons.push('requiresConfirmation must be stated explicitly');
  }
  if (input.connector !== undefined) {
    const reference = input.connector;
    if (
      typeof reference !== 'object' ||
      reference === null ||
      typeof reference.connectorId !== 'string' ||
      reference.connectorId.length === 0 ||
      typeof reference.operationId !== 'string' ||
      reference.operationId.length === 0
    ) {
      reasons.push('connector reference must provide connectorId and operationId');
    }
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid tool definition: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    version: input.version,
    category: input.category,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    requiredPermissions: [...input.requiredPermissions],
    ...(input.connector !== undefined ? { connector: { ...input.connector } } : {}),
    riskLevel: input.riskLevel,
    requiresConfirmation: input.requiresConfirmation,
  };
}

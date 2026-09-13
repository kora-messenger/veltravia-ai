import type { ToolDefinition } from '../types/definition.js';
import { isToolCategory } from '../types/category.js';
import { isPermissionRiskLevel } from '@veltravia/connector-core';
import { defineObjectSchema, validateToolObject } from '../validation/schema.js';

/**
 * Structural validation of a ToolDefinition before it can enter the
 * registry. Collects ALL problems and reports them in one error so tool
 * authors fix everything in one pass. Validation never touches behavior,
 * credentials, or external systems.
 */
export function validateToolDefinition(tool: unknown): readonly string[] {
  const reasons: string[] = [];
  if (tool === null || typeof tool !== 'object') {
    return ['tool must be an object implementing the ToolDefinition type'];
  }
  const candidate = tool as Partial<ToolDefinition>;

  // --- identity -------------------------------------------------------------
  if (
    typeof candidate.id !== 'string' ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(candidate.id) ||
    candidate.id.length > 128
  ) {
    reasons.push('id must be lowercase dot/dash-separated segments (max 128 chars)');
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    reasons.push('name must be a non-empty string');
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
    reasons.push('description must be a non-empty string');
  }
  if (
    typeof candidate.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate.version)
  ) {
    reasons.push('version must be semver (e.g. "1.0.0")');
  }
  if (!isToolCategory(candidate.category)) {
    reasons.push('category is unknown');
  }

  // --- permissions ------------------------------------------------------------
  if (!Array.isArray(candidate.requiredPermissions) || candidate.requiredPermissions.length === 0) {
    reasons.push('requiredPermissions must declare at least one permission id');
  } else {
    const seen = new Set<string>();
    for (const permissionId of candidate.requiredPermissions) {
      if (
        typeof permissionId !== 'string' ||
        !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(permissionId)
      ) {
        reasons.push(`required permission "${String(permissionId)}" is not a valid permission id`);
      } else if (seen.has(permissionId)) {
        reasons.push(`duplicate required permission "${permissionId}"`);
      }
      seen.add(String(permissionId));
    }
  }

  // --- risk & confirmation ------------------------------------------------------
  if (!isPermissionRiskLevel(candidate.riskLevel)) {
    reasons.push('riskLevel is unknown');
  }
  if (typeof candidate.requiresConfirmation !== 'boolean') {
    reasons.push('requiresConfirmation must be a boolean');
  }

  // --- connector reference (never executed directly) -----------------------------
  if (candidate.connector !== undefined) {
    const reference = candidate.connector;
    if (
      reference === null ||
      typeof reference !== 'object' ||
      typeof reference.connectorId !== 'string' ||
      reference.connectorId.length === 0 ||
      typeof reference.operationId !== 'string' ||
      reference.operationId.length === 0
    ) {
      reasons.push('connector reference must provide connectorId and operationId');
    }
  }

  // --- schemas: prove they are self-consistent and usable ---------------------------
  for (const [role, schema] of [
    ['inputSchema', candidate.inputSchema],
    ['outputSchema', candidate.outputSchema],
  ] as const) {
    if (
      schema === null ||
      typeof schema !== 'object' ||
      (schema as { type?: unknown }).type !== 'object'
    ) {
      reasons.push(`${role} must be an object schema`);
      continue;
    }
    // Round-trip through the schema factory: catches bad properties/required refs.
    const objectSchema = schema as unknown as {
      description?: string;
      properties: Record<string, Parameters<typeof defineObjectSchema>[0]['properties'][string]>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };
    try {
      const rebuilt = defineObjectSchema({
        ...(objectSchema.description !== undefined
          ? { description: objectSchema.description }
          : {}),
        properties: objectSchema.properties,
        ...(objectSchema.required !== undefined ? { required: objectSchema.required } : {}),
        ...(objectSchema.additionalProperties !== undefined
          ? { additionalProperties: objectSchema.additionalProperties }
          : {}),
      });
      // The declared schema must accept an empty object without structural
      // complaints - only "required field is missing" notes are acceptable.
      const problems = validateToolObject(rebuilt, {});
      if (problems.some((problem) => !problem.includes('required field is missing'))) {
        reasons.push(`${role} does not behave like a valid schema`);
      }
    } catch (error) {
      reasons.push(`${role} is invalid: ${(error as Error).message}`);
    }
  }

  return reasons;
}

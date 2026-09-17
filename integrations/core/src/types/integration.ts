import { redactSecrets, scrubDetails, type Permission } from '@veltravia/connector-core';

import { isIntegrationCapability } from './category.js';

import type {
  IntegrationCapability,
  IntegrationCategory,
  IntegrationEnvironment,
} from './category.js';

/**
 * The integration / plugin domain model - the PLATFORM-facing identity card
 * of one external integration. Pure metadata: no behavior, no secrets, no
 * vendor coupling.
 *
 * Boundaries (see docs/integrations.md):
 * - An INTEGRATION is the catalog entry ("GitHub", "Object Storage").
 * - A CONNECTOR is the code object that implements the integration against
 *   the external service (one integration = one connector, same id).
 * - A CONNECTION is one configured instance of an integration, owned by a
 *   user / workspace / project boundary.
 * - A CREDENTIAL REFERENCE points at a secret in the SecretStore. The raw
 *   secret NEVER appears here (structural: no field can carry a value).
 */
export interface IntegrationDefinition {
  /** Unique, stable, machine-friendly id (kebab-case, e.g. "github"). */
  readonly id: string;
  /** Human display name. */
  readonly name: string;
  /** One or two sentences on what this integration connects to. */
  readonly description: string;
  /** Integration version (semver). */
  readonly version: string;
  /** Publisher/owner label (e.g. "Veltravia" or "acme-platform"). */
  readonly publisher: string;
  /** Metadata-only category - never drives security behavior. */
  readonly category: IntegrationCategory;
  /**
   * Optional icon/reference metadata (e.g. "initial:G"). A reference to a
   * future asset system, never binary data and never a remote URL that the
   * app fetches without review.
   */
  readonly iconRef?: string;
  /** How this integration authenticates - a TYPE, never the credential. */
  readonly authenticationType: IntegrationAuthenticationType;
  /** Generic capabilities the integration declares - never auto-granted. */
  readonly capabilities: readonly IntegrationCapability[];
  /**
   * The scope catalog the integration declares (what it COULD be granted).
   * Structurally the connector Permission model: id + description + risk.
   */
  readonly scopes: readonly Permission[];
  /** Tool declarations the integration exposes through the Tool System. */
  readonly tools: readonly IntegrationToolDeclaration[];
  /** Environments this integration may run in (metadata). */
  readonly environments: readonly IntegrationEnvironment[];
  /** Optional documentation/reference metadata (URLs to DOCS, never code). */
  readonly documentation?: readonly { readonly label: string; readonly url: string }[];
}

/** How an integration authenticates - a classification, never a value. */
export const INTEGRATION_AUTHENTICATION_TYPES = [
  'none',
  'api_key',
  'access_token',
  'oauth_token',
  'password',
  'connection_string',
] as const;

export type IntegrationAuthenticationType = (typeof INTEGRATION_AUTHENTICATION_TYPES)[number];

export function isIntegrationAuthenticationType(
  value: unknown,
): value is IntegrationAuthenticationType {
  return (
    typeof value === 'string' &&
    (INTEGRATION_AUTHENTICATION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * One tool an integration exposes. This is a DECLARATION: the actual
 * Tool System registration happens through the normal, gated pipeline -
 * an integration can never register a tool the operator did not wire.
 */
export interface IntegrationToolDeclaration {
  /** Tool id, unique platform-wide (dot-separated lowercase). */
  readonly id: string;
  /** Human display name. */
  readonly name: string;
  /** What the tool does, in one or two sentences. */
  readonly description: string;
  /** Connector operation the tool routes through (never executed directly). */
  readonly operationId: string;
  /** Scope ids required to invoke the tool (must exist in `scopes`). */
  readonly requiredScopes: readonly string[];
  /** Risk level - high/critical always force human confirmation. */
  readonly riskLevel: Permission['riskLevel'];
  /** Whether the tool asks for confirmation even at lower risk. */
  readonly requiresConfirmation: boolean;
}

const INTEGRATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SCOPE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Rejects any string value that carries secret-shaped content. */
function assertNoSecretShapedStrings(value: unknown, where: string): string[] {
  const reasons: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (redactSecrets(node) !== node) {
        reasons.push(`${path} must not contain secret-shaped values`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${String(index)}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };
  walk(value, where);
  return reasons;
}

/**
 * Validates and creates an integration definition. This is the ONLY
 * supported constructor: it rejects duplicate/invalid tool ids, unknown
 * categories/capabilities, undeclared scope references, and any
 * secret-shaped metadata value.
 */
export function defineIntegration(input: IntegrationDefinition): IntegrationDefinition {
  const reasons: string[] = [];

  if (
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 64 ||
    !INTEGRATION_ID_PATTERN.test(input.id)
  ) {
    reasons.push('id must be kebab-case (max 64 chars)');
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
  if (typeof input.publisher !== 'string' || input.publisher.trim().length === 0) {
    reasons.push('publisher must be a non-empty string');
  }
  if (typeof input.category !== 'string' || !isIntegrationCategoryValue(input.category)) {
    reasons.push(`category "${String(input.category)}" is unknown`);
  }
  if (!isIntegrationAuthenticationType(input.authenticationType)) {
    reasons.push('authenticationType is unknown');
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    reasons.push('capabilities must list at least one declared capability');
  } else {
    for (const capability of input.capabilities) {
      if (!isIntegrationCapability(capability)) {
        reasons.push(`capability "${String(capability)}" is unknown`);
      }
    }
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    reasons.push('scopes must declare at least one scope');
  } else {
    const scopeIds = new Set<string>();
    for (const scope of input.scopes) {
      if (
        scope === null ||
        typeof scope !== 'object' ||
        typeof scope.id !== 'string' ||
        !SCOPE_ID_PATTERN.test(scope.id) ||
        typeof scope.description !== 'string' ||
        scope.description.trim().length === 0 ||
        !isPermissionRiskLevelValue(scope.riskLevel)
      ) {
        reasons.push(`scope "${String(scope?.id ?? '(missing)')}" is not a valid scope`);
      } else {
        scopeIds.add(scope.id);
      }
    }
    if (!Array.isArray(input.tools) || input.tools.length === 0) {
      reasons.push('tools must declare at least one tool');
    } else {
      const toolIds = new Set<string>();
      for (const tool of input.tools) {
        if (
          tool === null ||
          typeof tool !== 'object' ||
          typeof tool.id !== 'string' ||
          !SCOPE_ID_PATTERN.test(tool.id) ||
          tool.id.length > 128
        ) {
          reasons.push('every tool must have a valid dot-separated id');
          continue;
        }
        if (toolIds.has(tool.id)) reasons.push(`tool "${tool.id}" is declared twice`);
        toolIds.add(tool.id);
        if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
          reasons.push(`tool "${tool.id}" must have a non-empty name`);
        }
        if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
          reasons.push(`tool "${tool.id}" must have a non-empty description`);
        }
        if (typeof tool.operationId !== 'string' || tool.operationId.length === 0) {
          reasons.push(`tool "${tool.id}" must reference a connector operation id`);
        }
        if (!Array.isArray(tool.requiredScopes) || tool.requiredScopes.length === 0) {
          reasons.push(`tool "${tool.id}" must require at least one scope`);
        } else {
          for (const scopeId of tool.requiredScopes) {
            if (typeof scopeId !== 'string' || !scopeIds.has(scopeId)) {
              reasons.push(
                `tool "${tool.id}" requires scope "${String(scopeId)}" which the integration does not declare`,
              );
            }
          }
        }
        if (!isPermissionRiskLevelValue(tool.riskLevel)) {
          reasons.push(`tool "${tool.id}" has an unknown risk level`);
        }
        if (typeof tool.requiresConfirmation !== 'boolean') {
          reasons.push(`tool "${tool.id}" must state requiresConfirmation explicitly`);
        }
      }
    }
  }
  if (!Array.isArray(input.environments) || input.environments.length === 0) {
    reasons.push('environments must list at least one supported environment');
  } else {
    for (const environment of input.environments) {
      if (environment !== 'development' && environment !== 'production') {
        reasons.push(`environment "${String(environment)}" is unknown`);
      }
    }
  }
  if (
    input.iconRef !== undefined &&
    (typeof input.iconRef !== 'string' || input.iconRef.length > 128)
  ) {
    reasons.push('iconRef must be a short metadata string');
  }
  if (input.documentation !== undefined) {
    if (!Array.isArray(input.documentation)) {
      reasons.push('documentation must be a list of {label,url} entries');
    } else {
      for (const entry of input.documentation) {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          typeof entry.label !== 'string' ||
          entry.label.length === 0 ||
          typeof entry.url !== 'string' ||
          !/^https:\/\//.test(entry.url)
        ) {
          reasons.push('documentation entries must have a label and an https url');
        }
      }
    }
  }
  reasons.push(...assertNoSecretShapedStrings(input, 'integration definition'));

  if (reasons.length > 0) {
    throw new Error(`Invalid integration definition: ${reasons.join('; ')}.`);
  }

  return {
    id: input.id,
    name: input.name,
    description: input.description,
    version: input.version,
    publisher: input.publisher,
    category: input.category,
    ...(input.iconRef !== undefined ? { iconRef: input.iconRef } : {}),
    authenticationType: input.authenticationType,
    capabilities: [...input.capabilities],
    scopes: input.scopes.map((scope) => ({ ...scope })),
    tools: input.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      operationId: tool.operationId,
      requiredScopes: [...tool.requiredScopes],
      riskLevel: tool.riskLevel,
      requiresConfirmation: tool.requiresConfirmation,
    })),
    environments: [...input.environments],
    ...(input.documentation !== undefined
      ? { documentation: input.documentation.map((entry) => ({ ...entry })) }
      : {}),
  };
}

/** Local risk-level guard (avoids importing the connector union type here). */
function isPermissionRiskLevelValue(value: unknown): value is Permission['riskLevel'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function isIntegrationCategoryValue(value: string): value is IntegrationCategory {
  return (
    value === 'development' ||
    value === 'communication' ||
    value === 'databases' ||
    value === 'storage' ||
    value === 'productivity' ||
    value === 'payments' ||
    value === 'deployment' ||
    value === 'search' ||
    value === 'analytics' ||
    value === 'ai' ||
    value === 'other'
  );
}

/** Scrubs an integration definition into a safe, serializable view. */
export function integrationToSafeView(
  definition: IntegrationDefinition,
): Readonly<Record<string, unknown>> {
  return scrubDetails({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    publisher: definition.publisher,
    category: definition.category,
    iconRef: definition.iconRef,
    authenticationType: definition.authenticationType,
    capabilities: [...definition.capabilities],
    scopes: definition.scopes.map((scope) => ({
      id: scope.id,
      description: scope.description,
      riskLevel: scope.riskLevel,
    })),
    tools: definition.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      requiredScopes: [...tool.requiredScopes],
      riskLevel: tool.riskLevel,
      requiresConfirmation:
        tool.requiresConfirmation || tool.riskLevel === 'high' || tool.riskLevel === 'critical',
    })),
    environments: [...definition.environments],
    documentation: definition.documentation,
  }) as Readonly<Record<string, unknown>>;
}

import { redactSecrets } from '@veltravia/connector-core';

import { createIntegrationAuditEvent, type IntegrationAuditSink } from '../audit/index.js';
import { InvalidIntegrationError } from '../errors/index.js';
import { defineIntegration, type IntegrationDefinition } from '../types/integration.js';
import type { IntegrationCategory } from '../types/category.js';

/**
 * The versioned PLUGIN MANIFEST format (v1).
 *
 * A manifest is a DECLARATIVE, validated description a future third-party
 * publisher could submit. It describes an integration's identity, scopes,
 * tools, and risk metadata. It is DATA, never CODE:
 *
 * - unknown top-level fields are REJECTED (strict validation)
 * - executable/code-shaped fields (code, entry, script, hooks, install,
 *   commands, url-execution, ...) are REJECTED outright
 * - secret-shaped values anywhere in the manifest are REJECTED
 * - nothing in a manifest is ever executed, fetched, or interpreted
 *
 * A manifest can only ever become a catalog definition
 * (manifestToIntegrationDefinition) - registration still goes through the
 * same reviewed path as first-party integrations. A future plugin SDK /
 * isolated runtime may build on this format; executing arbitrary plugin
 * code is explicitly OUT of scope.
 */

export const INTEGRATION_MANIFEST_VERSION = '1';

/** Fields a manifest must never carry - code execution and unsafe shapes. */
const FORBIDDEN_TOP_LEVEL_KEYS = [
  'code',
  'entry',
  'entrypoint',
  'script',
  'scripts',
  'main',
  'module',
  'hooks',
  'handlers',
  'install',
  'installer',
  'postInstall',
  'commands',
  'executable',
  'runtime',
  'sdk',
  'url',
  'download',
  'fetch',
  'webhook',
  'secrets',
  'credentials',
  'env',
  'environment',
] as const;

const ALLOWED_TOP_LEVEL_KEYS = ['manifestVersion', 'integration'] as const;

/** The v1 manifest shape (after validation - input can be anything). */
export interface IntegrationManifest {
  readonly manifestVersion: typeof INTEGRATION_MANIFEST_VERSION;
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly version: string;
    readonly publisher: string;
    readonly category: IntegrationCategory;
    readonly authenticationType: string;
    readonly capabilities: readonly string[];
    readonly scopes: readonly {
      readonly id: string;
      readonly description: string;
      readonly riskLevel: string;
    }[];
    readonly tools: readonly {
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly operationId: string;
      readonly requiredScopes: readonly string[];
      readonly riskLevel: string;
      readonly requiresConfirmation: boolean;
    }[];
    readonly environments: readonly string[];
  };
}

export interface ValidateManifestResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Recursively collects unknown/dangerous keys and secret-shaped values. */
function inspect(node: unknown, path: string, reasons: string[]): void {
  if (typeof node === 'string') {
    if (redactSecrets(node) !== node) {
      reasons.push(`${path} contains a secret-shaped value - manifests never carry secrets`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => inspect(item, `${path}[${String(index)}]`, reasons));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof key === 'string' &&
        (FORBIDDEN_TOP_LEVEL_KEYS as readonly string[]).includes(key)
      ) {
        reasons.push(`${path} contains the forbidden field "${key}"`);
      }
      inspect(value, `${path}.${key}`, reasons);
    }
  }
}

/**
 * Validates an untrusted manifest. Unknown top-level fields are rejected
 * (strict): a manifest that carries anything outside the v1 contract is
 * invalid, so a future hostile publisher cannot smuggle behavior.
 */
export function validateIntegrationManifest(raw: unknown): ValidateManifestResult {
  const reasons: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reasons: ['manifest must be a JSON object'] };
  }
  const manifest = raw as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (!(ALLOWED_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      reasons.push(`unknown top-level field "${key}" is not part of manifest v1`);
    }
  }
  if (manifest['manifestVersion'] !== INTEGRATION_MANIFEST_VERSION) {
    reasons.push(`manifestVersion must be "${INTEGRATION_MANIFEST_VERSION}"`);
  }
  const integration = manifest['integration'];
  if (integration === null || typeof integration !== 'object' || Array.isArray(integration)) {
    reasons.push('integration must be an object');
    return { valid: false, reasons };
  }
  inspect(integration, 'integration', reasons);
  if (reasons.length > 0) return { valid: false, reasons };
  return { valid: true, reasons: [] };
}

/**
 * Converts a VALIDATED manifest into an IntegrationDefinition through the
 * same defineIntegration() gate every first-party integration passes.
 * The manifest has no power of its own: it can only become catalog data.
 */
export function manifestToIntegrationDefinition(
  raw: unknown,
  options: { readonly onAudit?: IntegrationAuditSink } = {},
): IntegrationDefinition {
  const validation = validateIntegrationManifest(raw);
  if (!validation.valid) {
    options.onAudit?.(
      createIntegrationAuditEvent({
        type: 'integration.manifest_rejected',
        integrationId: 'unknown',
        summary: `Manifest rejected: ${validation.reasons.join('; ')}`,
      }),
    );
    throw new InvalidIntegrationError(validation.reasons);
  }
  const manifest = raw as unknown as IntegrationManifest;
  const integration = manifest.integration;
  try {
    return defineIntegration({
      id: integration.id,
      name: integration.name,
      description: integration.description,
      version: integration.version,
      publisher: integration.publisher,
      category: integration.category,
      authenticationType:
        integration.authenticationType as IntegrationDefinition['authenticationType'],
      capabilities: integration.capabilities as IntegrationDefinition['capabilities'],
      scopes: integration.scopes.map((scope) => ({
        id: scope.id,
        description: scope.description,
        riskLevel: scope.riskLevel as IntegrationDefinition['scopes'][number]['riskLevel'],
      })),
      tools: integration.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        operationId: tool.operationId,
        requiredScopes: [...tool.requiredScopes],
        riskLevel: tool.riskLevel as IntegrationDefinition['tools'][number]['riskLevel'],
        requiresConfirmation: tool.requiresConfirmation,
      })),
      environments: integration.environments as IntegrationDefinition['environments'],
    });
  } catch (error) {
    options.onAudit?.(
      createIntegrationAuditEvent({
        type: 'integration.manifest_rejected',
        integrationId: integration.id,
        summary: `Manifest rejected during definition validation: ${(error as Error).message}`,
      }),
    );
    throw error;
  }
}

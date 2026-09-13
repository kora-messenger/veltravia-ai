import { redactSecrets } from '../errors/index.js';
import {
  isCredentialStatus,
  isCredentialType,
  type CredentialReference,
} from '../credentials/index.js';
import { defineOperation, type ConnectorOperation } from '../operations/index.js';
import { definePermission, isPermissionRiskLevel, type Permission } from '../permissions/index.js';
import { isConnectorCapability } from '../types/capabilities.js';
import { isConnectorCategory } from '../types/category.js';
import type { ConnectorMetadata } from '../types/metadata.js';
import type { Connector } from '../types/connector.js';

/**
 * Structural validation of a Connector implementation before it can enter
 * the registry. Collects ALL problems and reports them in one error so
 * connector authors fix everything in one pass.
 */
export function validateConnector(connector: unknown): readonly string[] {
  const reasons: string[] = [];
  if (connector === null || typeof connector !== 'object') {
    return ['connector must be an object implementing the Connector interface'];
  }
  const candidate = connector as Partial<Connector>;

  // --- metadata ------------------------------------------------------------
  const metadata = candidate.metadata as Partial<ConnectorMetadata> | undefined;
  if (metadata === null || typeof metadata !== 'object') {
    reasons.push('metadata must be an object');
  } else {
    if (
      typeof metadata.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.id) ||
      metadata.id.length > 64
    ) {
      reasons.push('metadata.id must be kebab-case (lowercase, hyphen-separated, max 64 chars)');
    }
    if (typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
      reasons.push('metadata.name must be a non-empty string');
    }
    if (
      typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)
    ) {
      reasons.push('metadata.version must be semver (e.g. "1.0.0")');
    }
    if (typeof metadata.description !== 'string' || metadata.description.trim().length === 0) {
      reasons.push('metadata.description must be a non-empty string');
    }
    if (!isConnectorCategory(metadata.category)) {
      reasons.push('metadata.category is unknown');
    }
    if (!Array.isArray(metadata.capabilities) || metadata.capabilities.length === 0) {
      reasons.push('metadata.capabilities must declare at least one capability');
    } else {
      const seen = new Set<string>();
      for (const capability of metadata.capabilities) {
        if (!isConnectorCapability(capability)) {
          reasons.push(`unknown capability "${String(capability)}"`);
        } else if (seen.has(capability)) {
          reasons.push(`duplicate capability "${capability}"`);
        }
        seen.add(String(capability));
      }
    }
  }

  // --- permissions (declared catalog) --------------------------------------
  const declaredPermissionIds = new Set<string>();
  if (!Array.isArray(candidate.permissions)) {
    reasons.push('permissions must be an array of Permission objects');
  } else {
    for (const permission of candidate.permissions) {
      const permissionReasons = validatePermission(permission);
      if (permissionReasons.length > 0) {
        reasons.push(...permissionReasons);
      } else {
        const id = (permission as Permission).id;
        if (declaredPermissionIds.has(id)) reasons.push(`duplicate permission id "${id}"`);
        declaredPermissionIds.add(id);
      }
    }
  }

  // --- operations ------------------------------------------------------------
  const operationIds = new Set<string>();
  if (!Array.isArray(candidate.operations)) {
    reasons.push('operations must be an array of ConnectorOperation objects');
  } else {
    for (const operation of candidate.operations) {
      const operationReasons = validateOperation(operation);
      if (operationReasons.length > 0) {
        reasons.push(...operationReasons);
      } else {
        const declared = operation as ConnectorOperation;
        if (operationIds.has(declared.id)) {
          reasons.push(`duplicate operation id "${declared.id}"`);
        }
        operationIds.add(declared.id);
        for (const required of declared.requiredPermissions) {
          if (!declaredPermissionIds.has(required)) {
            reasons.push(`operation "${declared.id}" requires undeclared permission "${required}"`);
          }
        }
      }
    }
  }

  // --- credential reference (metadata only, never a secret) ------------------
  if (candidate.credential !== undefined) {
    const credential = candidate.credential as Partial<CredentialReference> | null;
    if (credential === null || typeof credential !== 'object') {
      reasons.push('credential must be a CredentialReference object');
    } else {
      if (
        typeof credential.credentialId !== 'string' ||
        credential.credentialId.trim().length === 0
      ) {
        reasons.push('credential.credentialId must be a non-empty string');
      }
      if (!isCredentialType(credential.credentialType)) {
        reasons.push('credential.credentialType is unknown');
      }
      if (
        typeof credential.providerRef !== 'string' ||
        credential.providerRef.trim().length === 0
      ) {
        reasons.push('credential.providerRef must be a non-empty string');
      }
      if (credential.status !== undefined && !isCredentialStatus(credential.status)) {
        reasons.push('credential.status is unknown');
      }
      // Defense-in-depth: reject raw-looking secrets smuggled into ANY field.
      const serialized = JSON.stringify(credential);
      if (serialized !== redactSecrets(serialized)) {
        reasons.push('credential contains secret-like material - references only, never values');
      }
    }
  }

  // --- behavior ---------------------------------------------------------------
  if (typeof candidate.getStatus !== 'function') {
    reasons.push('getStatus() must be a function');
  }
  if (typeof candidate.checkHealth !== 'function') {
    reasons.push('checkHealth() must be a function');
  }
  if (typeof candidate.connect !== 'function') {
    reasons.push('connect() must be a function');
  }
  if (typeof candidate.disconnect !== 'function') {
    reasons.push('disconnect() must be a function');
  }

  return reasons;
}

function validatePermission(value: unknown): readonly string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    return ['each permission must be an object'];
  }
  const permission = value as Partial<Permission>;
  const label = typeof permission.id === 'string' ? permission.id : '(unnamed)';
  if (typeof permission.id !== 'string' || permission.id.length === 0) {
    reasons.push('permission id must be a non-empty string');
  } else if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(permission.id)) {
    reasons.push(`permission "${label}" id must be lowercase dot/dash-separated segments`);
  }
  if (typeof permission.description !== 'string' || permission.description.trim().length === 0) {
    reasons.push(`permission "${label}" must have a non-empty description`);
  }
  if (!isPermissionRiskLevel(permission.riskLevel)) {
    reasons.push(`permission "${label}" has an unknown risk level`);
  }
  if (reasons.length === 0) {
    // Round-trip through definePermission to prove it satisfies the contract.
    try {
      definePermission(
        permission.id as string,
        permission.description as string,
        permission.riskLevel as never,
      );
    } catch (error) {
      reasons.push(`permission "${label}" is invalid: ${(error as Error).message}`);
    }
  }
  return reasons;
}

function validateOperation(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') {
    return ['each operation must be an object'];
  }
  try {
    defineOperation(value as ConnectorOperation);
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}

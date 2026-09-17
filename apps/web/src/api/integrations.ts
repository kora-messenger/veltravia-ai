/**
 * Integration API surface + safe UI models (Step 12).
 *
 * Raw backend responses are mapped into typed view models before reaching
 * the UI: unknown/invalid data becomes a typed error, and nothing from the
 * payload is passed through unvalidated. Scope, tool, and connection data
 * is metadata only - the backend never sends credentials, and the client
 * cannot request them.
 */
import { apiRequest } from './client';

export type ConnectionStatus = 'connected' | 'disconnected' | 'disabled' | 'error';
export type IntegrationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Safe UI model for one scope an integration can grant. */
export interface IntegrationScopeView {
  readonly id: string;
  readonly description: string;
  readonly riskLevel: IntegrationRiskLevel;
}

/** Safe UI model for one tool an integration exposes. */
export interface IntegrationToolView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiredScopes: readonly string[];
  readonly riskLevel: IntegrationRiskLevel;
  readonly requiresConfirmation: boolean;
}

/** Safe UI model for one owner connection (metadata only, never secrets). */
export interface IntegrationConnectionView {
  readonly connectionId: string;
  readonly status: ConnectionStatus;
  readonly accountRef: string;
  readonly grantedScopes: readonly string[];
  readonly createdAt: string;
  readonly lastStatusCheckAt: string | null;
  readonly operationCount: number;
}

/** Safe UI model for one integration from the catalog. */
export interface IntegrationView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly publisher: string;
  readonly category: string;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly scopes: readonly IntegrationScopeView[];
  readonly tools: readonly IntegrationToolView[];
  readonly connections: readonly IntegrationConnectionView[];
}

const RISK_LEVELS: readonly IntegrationRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const STATUSES: readonly ConnectionStatus[] = ['connected', 'disconnected', 'disabled', 'error'];

function toRiskLevel(value: unknown): IntegrationRiskLevel {
  return RISK_LEVELS.includes(value as IntegrationRiskLevel)
    ? (value as IntegrationRiskLevel)
    : 'low';
}

function invalid(source: string): Error {
  return new Error(`Invalid integration payload from ${source}`);
}

function toScopeView(raw: unknown, source: string): IntegrationScopeView {
  if (typeof raw !== 'object' || raw === null) throw invalid(source);
  const record = raw as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['description'] !== 'string') {
    throw invalid(source);
  }
  return {
    id: record['id'],
    description: record['description'],
    riskLevel: toRiskLevel(record['riskLevel']),
  };
}

function toToolView(raw: unknown, source: string): IntegrationToolView {
  if (typeof raw !== 'object' || raw === null) throw invalid(source);
  const record = raw as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    typeof record['name'] !== 'string' ||
    typeof record['description'] !== 'string'
  ) {
    throw invalid(source);
  }
  return {
    id: record['id'],
    name: record['name'],
    description: record['description'],
    requiredScopes: Array.isArray(record['requiredScopes'])
      ? record['requiredScopes'].filter((scope): scope is string => typeof scope === 'string')
      : [],
    riskLevel: toRiskLevel(record['riskLevel']),
    requiresConfirmation: record['requiresConfirmation'] === true,
  };
}

function toConnectionView(raw: unknown, source: string): IntegrationConnectionView {
  if (typeof raw !== 'object' || raw === null) throw invalid(source);
  const record = raw as Record<string, unknown>;
  if (typeof record['connectionId'] !== 'string') throw invalid(source);
  const status = STATUSES.includes(record['status'] as ConnectionStatus)
    ? (record['status'] as ConnectionStatus)
    : 'error';
  return {
    connectionId: record['connectionId'],
    status,
    accountRef: typeof record['accountRef'] === 'string' ? record['accountRef'] : '',
    grantedScopes: Array.isArray(record['grantedScopes'])
      ? record['grantedScopes'].filter((scope): scope is string => typeof scope === 'string')
      : [],
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    lastStatusCheckAt:
      typeof record['lastStatusCheckAt'] === 'string' ? record['lastStatusCheckAt'] : null,
    operationCount: typeof record['operationCount'] === 'number' ? record['operationCount'] : 0,
  };
}

function toIntegrationView(raw: unknown, source: string): IntegrationView {
  if (typeof raw !== 'object' || raw === null) throw invalid(source);
  const record = raw as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    typeof record['name'] !== 'string' ||
    typeof record['description'] !== 'string'
  ) {
    throw invalid(source);
  }
  return {
    id: record['id'],
    name: record['name'],
    description: record['description'],
    version: typeof record['version'] === 'string' ? record['version'] : '',
    publisher: typeof record['publisher'] === 'string' ? record['publisher'] : '',
    category: typeof record['category'] === 'string' ? record['category'] : 'other',
    capabilities: Array.isArray(record['capabilities'])
      ? record['capabilities'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    enabled: record['enabled'] === true,
    scopes: Array.isArray(record['scopes'])
      ? record['scopes'].map((scope) => toScopeView(scope, source))
      : [],
    tools: Array.isArray(record['tools'])
      ? record['tools'].map((tool) => toToolView(tool, source))
      : [],
    connections: Array.isArray(record['connections'])
      ? record['connections'].map((connection) => toConnectionView(connection, source))
      : [],
  };
}

export async function listIntegrations(): Promise<readonly IntegrationView[]> {
  const payload = await apiRequest<unknown>('/api/integrations');
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    integrations?: unknown;
  };
  if (!Array.isArray(body.integrations)) {
    throw new Error('Invalid integration list payload');
  }
  return body.integrations.map((integration) => toIntegrationView(integration, 'catalog'));
}

export async function getIntegration(integrationId: string): Promise<IntegrationView> {
  const payload = await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}`,
  );
  return toIntegrationView(payload, 'integration detail');
}

export interface CreateConnectionInput {
  readonly scopes: readonly string[];
  readonly accountRef?: string;
}

export async function createConnection(
  integrationId: string,
  input: CreateConnectionInput,
): Promise<IntegrationConnectionView> {
  const payload = await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}/connections`,
    { method: 'POST', body: input },
  );
  return toConnectionView(payload, 'connection create');
}

export async function disableConnection(
  integrationId: string,
  connectionId: string,
): Promise<IntegrationConnectionView> {
  const payload = await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}/connections/${encodeURIComponent(connectionId)}/disable`,
    { method: 'POST' },
  );
  return toConnectionView(payload, 'connection disable');
}

export async function enableConnection(
  integrationId: string,
  connectionId: string,
): Promise<IntegrationConnectionView> {
  const payload = await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}/connections/${encodeURIComponent(connectionId)}/enable`,
    { method: 'POST' },
  );
  return toConnectionView(payload, 'connection enable');
}

export async function disconnectConnection(
  integrationId: string,
  connectionId: string,
): Promise<void> {
  await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  );
}

export async function checkConnectionStatus(
  integrationId: string,
  connectionId: string,
): Promise<IntegrationConnectionView> {
  const payload = await apiRequest<unknown>(
    `/api/integrations/${encodeURIComponent(integrationId)}/connections/${encodeURIComponent(connectionId)}/status-check`,
    { method: 'POST' },
  );
  return toConnectionView(payload, 'status check');
}

import { ApiError, apiRequest } from './client';
import { browserOwnerRef } from './owner-ref';

/**
 * Typed client for the agent's name.
 *
 * The name is what the owner calls their assistant. It is display-only: the
 * browser can read it and rename it, and nothing else. The request carries the
 * browser's owner reference so each person names their own agent.
 */

export interface AgentProfile {
  readonly agentName: string;
  readonly ownerName: string | null;
  readonly isDefault: boolean;
  readonly updatedAt: string | null;
}

export interface AgentProfileResponse {
  readonly profile: AgentProfile;
  readonly maxLength: number;
  /** Always false in this build: names live in the server's memory. */
  readonly durable: boolean;
  readonly note: string;
}

interface RawProfile {
  readonly agentName?: unknown;
  readonly ownerName?: unknown;
  readonly isDefault?: unknown;
  readonly updatedAt?: unknown;
}

interface RawBody {
  readonly profile?: RawProfile;
  readonly limits?: { readonly maxLength?: unknown };
  readonly persistence?: { readonly durable?: unknown; readonly note?: unknown };
}

function malformed(): ApiError {
  return new ApiError(0, 'INVALID_RESPONSE', 'The assistant’s name could not be read.');
}

function toResponse(raw: unknown): AgentProfileResponse {
  if (typeof raw !== 'object' || raw === null) throw malformed();
  const body = raw as RawBody;
  const profile = body.profile;
  if (profile === undefined || typeof profile.agentName !== 'string') throw malformed();
  return {
    profile: {
      agentName: profile.agentName,
      ownerName: typeof profile.ownerName === 'string' ? profile.ownerName : null,
      isDefault: profile.isDefault === true,
      updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : null,
    },
    maxLength: typeof body.limits?.maxLength === 'number' ? body.limits.maxLength : 40,
    durable: body.persistence?.durable === true,
    note: typeof body.persistence?.note === 'string' ? body.persistence.note : '',
  };
}

export interface AgentProfileOptions {
  readonly fetchImpl?: typeof fetch;
  readonly ownerRef?: string;
}

function request(
  path: string,
  method: 'GET' | 'PATCH' | 'DELETE',
  body: unknown,
  options: AgentProfileOptions,
): Promise<AgentProfileResponse> {
  const headers = { 'x-veltravia-owner-ref': options.ownerRef ?? browserOwnerRef() };
  return apiRequest<unknown>(path, {
    method,
    ...(body === undefined ? {} : { body }),
    headers,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }).then(toResponse);
}

export const getAgentProfile = (options: AgentProfileOptions = {}) =>
  request('/api/agent-profile', 'GET', undefined, options);

export const updateAgentProfile = (
  patch: { readonly agentName?: string; readonly ownerName?: string },
  options: AgentProfileOptions = {},
) => request('/api/agent-profile', 'PATCH', patch, options);

/** Puts the default agent name back; the owner's own name is kept. */
export const resetAgentName = (options: AgentProfileOptions = {}) =>
  request('/api/agent-profile/name', 'DELETE', undefined, options);

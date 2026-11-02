import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  MAX_NAME_LENGTH,
  agentProfileHttpStatus,
  isAgentProfileError,
  type AgentProfileStore,
} from '../agent-profile.js';

/**
 * Agent-profile routes.
 *
 * The owner is derived from the same header convention as the rest of the API
 * (a documented development stand-in for authentication), so each caller names
 * their own agent and cannot rename anyone else's.
 */

function ownerOf(request: FastifyRequest): string {
  const prefer = request.headers['x-veltravia-owner-ref'];
  const fallback = request.headers['x-veltravia-owner'];
  const raw =
    (Array.isArray(prefer) ? prefer[0] : prefer) ??
    (Array.isArray(fallback) ? fallback[0] : fallback);
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

const UPDATE_BODY = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    agentName: { type: 'string', maxLength: 200 },
    ownerName: { type: 'string', maxLength: 200 },
  },
} as const;

export interface AgentProfileDeps {
  readonly store: AgentProfileStore;
}

const PERSISTENCE_NOTE =
  'Names are held in memory for this server process. A restart restores the defaults; this is not presented as durable storage.';

function payload(store: AgentProfileStore, ownerRef: string) {
  return {
    profile: store.get(ownerRef),
    limits: { maxLength: MAX_NAME_LENGTH },
    persistence: { durable: false, note: PERSISTENCE_NOTE },
  };
}

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileDeps): void {
  app.get('/api/agent-profile', async (request, reply) => {
    return reply.send(payload(deps.store, ownerOf(request)));
  });

  app.patch<{ Body: { agentName?: string; ownerName?: string } }>(
    '/api/agent-profile',
    { schema: { body: UPDATE_BODY } },
    async (request, reply) => {
      const ownerRef = ownerOf(request);
      try {
        const profile = deps.store.update(ownerRef, request.body);
        return reply.send({
          profile,
          limits: { maxLength: MAX_NAME_LENGTH },
          persistence: { durable: false, note: PERSISTENCE_NOTE },
        });
      } catch (error) {
        if (isAgentProfileError(error)) {
          return reply.status(agentProfileHttpStatus(error.code)).send({
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
  );

  // Renaming is reversible, and putting the default back should not require
  // typing it: the owner starts over without a hidden value to remember.
  app.delete('/api/agent-profile/name', async (request, reply) => {
    const ownerRef = ownerOf(request);
    return reply.send({
      profile: deps.store.resetAgentName(ownerRef),
      limits: { maxLength: MAX_NAME_LENGTH },
      persistence: { durable: false, note: PERSISTENCE_NOTE },
    });
  });
}

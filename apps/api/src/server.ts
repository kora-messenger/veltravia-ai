import Fastify, { type FastifyInstance } from 'fastify';
import { formatTimestamp } from '@veltravia/shared';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION, type HealthCheckResponse } from '@veltravia/types';

/**
 * Builds the Fastify instance without starting it.
 * Tests use this entry point via fastify.inject(); main.ts starts the listener.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async (): Promise<HealthCheckResponse> => ({
    status: 'ok',
    service: `${VELTRAVIA_NAME} API`,
    version: VELTRAVIA_VERSION,
    timestamp: formatTimestamp(),
  }));

  return app;
}

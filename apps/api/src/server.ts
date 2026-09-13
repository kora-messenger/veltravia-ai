import Fastify, { type FastifyInstance } from 'fastify';
import type { AICore } from '@veltravia/ai-core';
import type { ConnectorManager } from '@veltravia/connector-core';
import { formatTimestamp } from '@veltravia/shared';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION, type HealthCheckResponse } from '@veltravia/types';
import { createAICore } from './ai.js';
import { createConnectorManager } from './connectors.js';
import { registerAIRoutes } from './routes/ai-generate.js';
import { registerConnectorRoutes } from './routes/connectors.js';

export interface BuildAppOptions {
  /** Pre-built AICore (tests inject one); defaults to the mock-backed core. */
  readonly aiCore?: AICore;
  /** Pre-built ConnectorManager (tests inject one); defaults to the mock connector. */
  readonly connectors?: ConnectorManager;
}

/**
 * Builds the Fastify instance without starting it.
 * Tests use this entry point via fastify.inject(); main.ts starts the listener.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Strict validation: unknown properties are rejected (400), not silently
    // stripped - the API contract stays exact.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get('/health', async (): Promise<HealthCheckResponse> => ({
    status: 'ok',
    service: `${VELTRAVIA_NAME} API`,
    version: VELTRAVIA_VERSION,
    timestamp: formatTimestamp(),
  }));

  const aiCore = options.aiCore ?? createAICore();
  registerAIRoutes(app, aiCore);

  // Read-only connector surface: metadata, capabilities, permissions, status.
  const connectors = options.connectors ?? createConnectorManager();
  registerConnectorRoutes(app, connectors);

  return app;
}

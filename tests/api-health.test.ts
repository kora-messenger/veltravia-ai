import { describe, expect, it } from 'vitest';
import { buildApp } from '@veltravia/api';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION, type HealthCheckResponse } from '@veltravia/types';

/**
 * Integration test: exercises the real Fastify app end-to-end (via inject)
 * and verifies the shared packages are wired correctly across workspaces.
 */
describe('Veltravia API (integration)', () => {
  it('serves a valid health check', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json<HealthCheckResponse>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe(`${VELTRAVIA_NAME} API`);
    expect(body.version).toBe(VELTRAVIA_VERSION);
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });
});

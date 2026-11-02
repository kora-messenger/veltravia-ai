import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/** The API's own reasoning surface, offline: no provider is connected here. */
function buildApiApp() {
  return buildApp({});
}

describe('POST /api/reasoning/runs/:runId/continue', () => {
  it('refuses a run it does not have, without leaking anything', async () => {
    const app = buildApiApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs/rsn_missing/continue',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REASONING_RUN_NOT_FOUND');
    app.close();
  });

  it('refuses to continue a run that finished on its own', async () => {
    const app = buildApiApp();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      payload: { task: 'Summarise the release notes.', mode: 'simulated', profile: 'workspace' },
    });
    expect([200, 202]).toContain(started.statusCode);
    const runId = started.json().run.id as string;

    // Wait for the deterministic simulated engine to reach a terminal state.
    let status = started.json().run.status as string;
    for (let attempt = 0; attempt < 40 && status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const read = await app.inject({ method: 'GET', url: `/api/reasoning/runs/${runId}` });
      status = read.json().run.status as string;
    }
    expect(status).toBe('completed');

    const response = await app.inject({
      method: 'POST',
      url: `/api/reasoning/runs/${runId}/continue`,
      payload: {},
    });
    // A completed run is not continuable: 409, never a silent new run.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REASONING_RUN_NOT_CONTINUABLE');
    app.close();
  });
});

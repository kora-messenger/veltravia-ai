import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/**
 * The run route takes a task of any length. The old 8,000-character schema
 * maximum rejected a pasted brief with a validation error, which a person reads
 * as "the app is broken", and it truncated the engine's own view of the prompt.
 */
function buildApiApp() {
  return buildApp({});
}

describe('POST /api/reasoning/runs with a long task', () => {
  it('accepts a brief well past the old ceiling and keeps it whole', async () => {
    const app = buildApiApp();
    const task = Array.from(
      { length: 800 },
      (_, i) => `Requirement ${i}:\n- keep behaviour\n- keep names`,
    ).join('\n\n');
    expect(task.length).toBeGreaterThan(30_000);

    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      payload: { task, mode: 'simulated', profile: 'workspace' },
    });
    expect([200, 202]).toContain(started.statusCode);
    const run = started.json().run as { task: string; id: string };
    // The stored task is the same text, with its blank lines and bullets intact.
    expect(run.task.length).toBeGreaterThanOrEqual(task.length - 4);
    expect(run.task).toContain('Requirement 799:\n- keep behaviour\n- keep names');

    app.close();
  }, 30_000);

  it('still refuses an empty task', async () => {
    const app = buildApiApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      payload: { task: '', mode: 'simulated', profile: 'workspace' },
    });
    expect(response.statusCode).toBe(400);
    app.close();
  });
});

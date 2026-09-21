import { describe, expect, it } from 'vitest';

import { captureRunEnd, captureRunStart } from '../run-captures.js';

/**
 * Step 18 route-level auto-captures: best-effort observability that NEVER
 * fails the run it brackets, and only fires `*_after` on terminal states.
 */

describe('run captures', () => {
  it('captures start and terminal end through the version manager', async () => {
    const calls: { source: string; projectId: string }[] = [];
    const version = {
      captureRevision: async (request: { source: string; projectId: string }) => {
        calls.push({ source: request.source, projectId: request.projectId });
      },
    };
    const hooks = { version: version as never };
    await captureRunStart(hooks, 'coding_before', 'p1', 'w1');
    await captureRunEnd(hooks, 'coding_after', 'p1', 'w1', 'awaiting_approval');
    await captureRunEnd(hooks, 'coding_after', 'p1', 'w1', 'completed');
    expect(calls).toEqual([
      { source: 'coding_before', projectId: 'p1' },
      { source: 'coding_after', projectId: 'p1' },
    ]);
  });

  it('never throws when the capture fails or the manager is absent', async () => {
    const version = {
      captureRevision: async () => {
        throw new Error('store full');
      },
    };
    await captureRunStart({ version: version as never }, 'testing_before_repair', 'p', 'w');
    await captureRunEnd({ version: version as never }, 'testing_after', 'p', 'w', 'failed');
    await captureRunStart({}, 'coding_before', 'p', 'w');
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});

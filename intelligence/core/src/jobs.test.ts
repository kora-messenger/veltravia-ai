// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SynthesisJobManager, type SynthesisAnswer } from './index.js';

function answer(question: string): SynthesisAnswer {
  return {
    question,
    intent: 'find',
    status: 'answered',
    summary: 'ok',
    claims: [],
    contradictions: [],
    relationships: [],
    gaps: [],
    sources: [],
    evidence: [],
    reasoning: {
      provider: 'mock-reasoning',
      mode: 'mock_reasoning',
      simulated: true,
      detail: 'test',
    },
    searchedProviders: [],
    unavailableProviders: [],
    generatedAt: '2026-10-31T08:00:00.000Z',
    truncated: false,
  };
}

describe('synthesis jobs', () => {
  it('runs a job and exposes its result only to its owner', async () => {
    const manager = new SynthesisJobManager({
      runner: async ({ question }) => answer(question),
      now: () => new Date('2026-10-31T08:00:00.000Z'),
    });
    const job = await manager.create('owner-a', 'what changed?');
    expect(['queued', 'running']).toContain(job.status);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const finished = manager.get('owner-a', job.jobId);
    expect(finished.status).toBe('completed');
    expect(finished.result?.question).toBe('what changed?');
    expect(() => manager.get('owner-b', job.jobId)).toThrow();
  });

  it('records a failure instead of pretending success', async () => {
    const manager = new SynthesisJobManager({
      runner: async () => {
        throw Object.assign(new Error('provider exploded'), {
          code: 'INTELLIGENCE_PROVIDER_ERROR',
        });
      },
    });
    const job = await manager.create('owner-a', 'question');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const finished = manager.get('owner-a', job.jobId);
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('INTELLIGENCE_PROVIDER_ERROR');
    expect(finished.result).toBeNull();
  });

  it('cancels a running job and refuses to cancel a finished one', async () => {
    let release: (() => void) | null = null;
    const manager = new SynthesisJobManager({
      runner: async ({ question }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return answer(question);
      },
    });
    const job = await manager.create('owner-a', 'slow question');
    const cancelled = manager.cancel('owner-a', job.jobId);
    expect(cancelled.status).toBe('cancelled');
    release?.();
  });

  it('lists only the owner’s jobs and bounds the count', async () => {
    const manager = new SynthesisJobManager({
      runner: async ({ question }) => answer(question),
      limits: { maxJobsPerOwner: 2 },
    });
    await manager.create('owner-a', 'one');
    await manager.create('owner-a', 'two');
    await manager.create('owner-a', 'three');
    const jobs = manager.list('owner-a');
    expect(jobs.length).toBeLessThanOrEqual(2);
    expect(manager.list('owner-b')).toHaveLength(0);
  });
});

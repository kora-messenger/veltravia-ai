// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as api from './intelligence';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = [string, RequestInit | undefined];

function recorder(body: unknown = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init]);
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('intelligence client', () => {
  it('encodes the search query and forwards filters', async () => {
    const { calls, fetchImpl } = recorder({ hits: [] });
    await api.searchSources('what changed?', { provider: 'notion', limit: 5 }, fetchImpl);
    expect(calls[0]![0]).toContain('/api/intelligence/search?');
    expect(calls[0]![0]).toContain('q=what+changed%3F');
    expect(calls[0]![0]).toContain('provider=notion');
    expect(calls[0]![0]).toContain('limit=5');
  });

  it('sends the question to analyze as a POST body', async () => {
    const { calls, fetchImpl } = recorder({ status: 'answered' });
    await api.analyze('What is the deadline?', { provider: 'files' }, fetchImpl);
    expect(calls[0]![0]).toBe('/api/intelligence/analyze');
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      question: 'What is the deadline?',
      provider: 'files',
    });
  });

  it('posts a comparison selection unchanged', async () => {
    const { calls, fetchImpl } = recorder({ participants: [] });
    await api.compare(['files:a', 'workspace:b'], fetchImpl);
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      sourceIds: ['files:a', 'workspace:b'],
    });
  });

  it('encodes job ids on every job path', async () => {
    const { calls, fetchImpl } = recorder({ jobId: 'job 1' });
    await api.getJob('job 1', fetchImpl);
    await api.getJobResult('job 1', fetchImpl);
    await api.cancelJob('job 1', fetchImpl);
    expect(calls.map((call) => call[0])).toEqual([
      '/api/intelligence/jobs/job%201',
      '/api/intelligence/jobs/job%201/result',
      '/api/intelligence/jobs/job%201/cancel',
    ]);
  });
});

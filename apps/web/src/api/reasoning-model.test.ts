import { afterEach, describe, expect, it, vi } from 'vitest';

import { setChatModel } from './reasoning';

/**
 * These run the real request code and replace only `fetch`, because the bug
 * they guard lived in what the request put on the wire: the body was
 * stringified twice, so the server received a JSON string literal instead of
 * an object and silently reset the choice to Automatic.
 */
function stubFetch(reply: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(reply), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setChatModel', () => {
  it('sends the chosen model as a JSON object the server can read', async () => {
    const calls = stubFetch({ choice: null });
    await setChatModel({ connectionId: 'conn-1', modelId: 'gpt-4o-mini' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('PUT');
    const sent: unknown = JSON.parse(String(calls[0]?.init.body));
    // A double-encoded body parses to a string here, not an object.
    expect(typeof sent).toBe('object');
    expect(sent).toEqual({ connectionId: 'conn-1', modelId: 'gpt-4o-mini' });
  });

  it('sends Automatic as an object too', async () => {
    const calls = stubFetch({ choice: null });
    await setChatModel(null);

    const sent: unknown = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toEqual({ automatic: true });
  });

  it('returns the model the server stored, so the chip can show it', async () => {
    const stored = {
      connectionId: 'conn-1',
      modelId: 'gpt-4o-mini',
      label: 'gpt-4o-mini',
      providerId: 'openai',
      providerName: 'OpenAI',
    };
    stubFetch({ choice: stored });
    await expect(setChatModel({ connectionId: 'conn-1', modelId: 'gpt-4o-mini' })).resolves.toEqual(
      stored,
    );
  });
});

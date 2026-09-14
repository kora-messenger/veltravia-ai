import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { ApiError, apiRequest, errorMessage } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('api client', () => {
  it('returns parsed JSON for successful requests', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { hello: 'world' }));
    const payload = await apiRequest<{ hello: string }>('/api/test', { fetchImpl });
    expect(payload).toEqual({ hello: 'world' });
  });

  it('sends JSON bodies with the POST method', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { ok: true }));
    await apiRequest('/api/test', { method: 'POST', body: { name: 'x' }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
    );
  });

  it('normalizes network failures to a NETWORK ApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('boom');
    });
    const failure = await apiRequest('/api/test', { fetchImpl }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('NETWORK');
    expect((failure as ApiError).status).toBe(0);
    expect(errorMessage(failure)).not.toMatch(/boom|TypeError/i);
  });

  it('maps API error bodies to code + message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, {
        error: { code: 'REVISION_CONFLICT', message: 'stale revision' },
      }),
    );
    const failure = await apiRequest('/api/test', { fetchImpl }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('REVISION_CONFLICT');
    expect((failure as ApiError).status).toBe(409);
  });

  it('uses a friendly fallback when the error body is unusable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, null));
    const failure = await apiRequest('/api/test', { fetchImpl }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(errorMessage(failure)).not.toMatch(/stack|at /i);
    expect((failure as ApiError).code).toBe('UNKNOWN');
  });

  it('exposes a user-presentable message for 404s', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: 'PROJECT_NOT_FOUND', message: '' } }),
    );
    const failure = await apiRequest('/api/test', { fetchImpl }).catch((error) => error);
    expect(errorMessage(failure)).toMatch(/no longer exists|not be found/i);
  });
});

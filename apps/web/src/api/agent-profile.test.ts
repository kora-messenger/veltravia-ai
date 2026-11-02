import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentProfile, resetAgentName, updateAgentProfile } from './agent-profile';
import { ApiError, apiRequest } from './client';

vi.mock('./client', async (importOriginal) => ({
  // Keep the real ApiError; only the transport is mocked.
  ...(await importOriginal<typeof import('./client')>()),
  apiRequest: vi.fn(),
}));

const mockedRequest = vi.mocked(apiRequest);

function body(profile: Record<string, unknown>, durable = false) {
  return {
    profile,
    limits: { maxLength: 40 },
    persistence: { durable, note: 'held in memory' },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('agent profile client', () => {
  it('reads the name for the calling browser and reports durability honestly', async () => {
    mockedRequest.mockResolvedValue(
      body({ agentName: 'Ada', ownerName: 'Ijezie', isDefault: false, updatedAt: 'now' }),
    );
    const response = await getAgentProfile({ ownerRef: 'owner-1' });
    expect(response.profile).toEqual({
      agentName: 'Ada',
      ownerName: 'Ijezie',
      isDefault: false,
      updatedAt: 'now',
    });
    expect(response.maxLength).toBe(40);
    expect(response.durable).toBe(false);
    expect(mockedRequest).toHaveBeenCalledWith(
      '/api/agent-profile',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-veltravia-owner-ref': 'owner-1' },
      }),
    );
  });

  it('sends only the fields that were changed', async () => {
    mockedRequest.mockResolvedValue(
      body({ agentName: 'Kora', ownerName: null, isDefault: false, updatedAt: 'now' }),
    );
    await updateAgentProfile({ agentName: 'Kora' }, { ownerRef: 'owner-1' });
    expect(mockedRequest).toHaveBeenCalledWith(
      '/api/agent-profile',
      expect.objectContaining({ method: 'PATCH', body: { agentName: 'Kora' } }),
    );
  });

  it('resets the name through the reset path', async () => {
    mockedRequest.mockResolvedValue(
      body({ agentName: 'My Engineer', ownerName: null, isDefault: true, updatedAt: null }),
    );
    const response = await resetAgentName({ ownerRef: 'owner-1' });
    expect(response.profile.agentName).toBe('My Engineer');
    expect(mockedRequest).toHaveBeenCalledWith(
      '/api/agent-profile/name',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('falls back to the default when an optional field is missing', async () => {
    mockedRequest.mockResolvedValue(body({ agentName: 'Ada' }));
    const response = await getAgentProfile({ ownerRef: 'owner-1' });
    expect(response.profile).toMatchObject({ ownerName: null, isDefault: false, updatedAt: null });
  });

  it('reports an unreadable body instead of rendering undefined', async () => {
    mockedRequest.mockResolvedValue({});
    await expect(getAgentProfile({ ownerRef: 'owner-1' })).rejects.toBeInstanceOf(ApiError);
    mockedRequest.mockResolvedValue({ profile: { agentName: 42 } });
    await expect(getAgentProfile({ ownerRef: 'owner-1' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('passes a server refusal through unchanged', async () => {
    mockedRequest.mockRejectedValue(new ApiError(422, 'AGENT_NAME_TOO_LONG', 'too long'));
    await expect(
      updateAgentProfile({ agentName: 'x'.repeat(41) }, { ownerRef: 'owner-1' }),
    ).rejects.toMatchObject({ status: 422, code: 'AGENT_NAME_TOO_LONG' });
  });
});

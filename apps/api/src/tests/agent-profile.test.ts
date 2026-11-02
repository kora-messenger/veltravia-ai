import { describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import {
  AgentProfileStore,
  DEFAULT_AGENT_NAME,
  MAX_NAME_LENGTH,
  normaliseName,
} from '../agent-profile.js';

const OWNER = { 'x-veltravia-owner-ref': 'owner-a' };

async function appWith() {
  return buildApp();
}

describe('agent profile', () => {
  it('gives a new owner the default agent name and no personal name', async () => {
    const app = await appWith();
    const response = await app.inject({ method: 'GET', url: '/api/agent-profile', headers: OWNER });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toEqual({
      agentName: DEFAULT_AGENT_NAME,
      ownerName: null,
      isDefault: true,
      updatedAt: null,
    });
    expect(response.json().limits.maxLength).toBe(MAX_NAME_LENGTH);
    expect(response.json().persistence.durable).toBe(false);
    await app.close();
  });

  it('names the agent and remembers it for that owner', async () => {
    const app = await appWith();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Veltravia Ops' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().profile.agentName).toBe('Veltravia Ops');
    expect(patch.json().profile.isDefault).toBe(false);
    expect(typeof patch.json().profile.updatedAt).toBe('string');

    const read = await app.inject({ method: 'GET', url: '/api/agent-profile', headers: OWNER });
    expect(read.json().profile.agentName).toBe('Veltravia Ops');
    await app.close();
  });

  it('stores the owner’s own name and keeps it when the agent is renamed', async () => {
    const app = await appWith();
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { ownerName: 'Ijezie' },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Ada' },
    });
    const read = await app.inject({ method: 'GET', url: '/api/agent-profile', headers: OWNER });
    expect(read.json().profile).toMatchObject({ agentName: 'Ada', ownerName: 'Ijezie' });
    await app.close();
  });

  it('sets both names in one request', async () => {
    const app = await appWith();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Kora', ownerName: 'Ijezie' },
    });
    expect(patch.json().profile).toMatchObject({ agentName: 'Kora', ownerName: 'Ijezie' });
    await app.close();
  });

  it('keeps each owner’s names to themselves', async () => {
    const app = await appWith();
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Owner A agent', ownerName: 'A' },
    });
    const other = await app.inject({
      method: 'GET',
      url: '/api/agent-profile',
      headers: { 'x-veltravia-owner-ref': 'owner-b' },
    });
    expect(other.json().profile).toEqual({
      agentName: DEFAULT_AGENT_NAME,
      ownerName: null,
      isDefault: true,
      updatedAt: null,
    });
    await app.close();
  });

  it('accepts the legacy owner header too', async () => {
    const app = await appWith();
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: { 'x-veltravia-owner': 'legacy-owner' },
      payload: { agentName: 'Legacy agent' },
    });
    const read = await app.inject({
      method: 'GET',
      url: '/api/agent-profile',
      headers: { 'x-veltravia-owner': 'legacy-owner' },
    });
    expect(read.json().profile.agentName).toBe('Legacy agent');
    await app.close();
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a newline', 'Bad\nName'],
    ['control characters', 'Bad\u0007Name'],
  ])('refuses %s as an agent name', async (_label, agentName) => {
    const app = await appWith();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('AGENT_NAME_INVALID');
    await app.close();
  });

  it('names the field when the personal name is the invalid one', async () => {
    const app = await appWith();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { ownerName: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('OWNER_NAME_INVALID');
    await app.close();
  });

  it('refuses a name longer than the limit', async () => {
    const app = await appWith();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'a'.repeat(MAX_NAME_LENGTH + 1) },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('AGENT_NAME_TOO_LONG');
    await app.close();
  });

  it('rejects an empty update and unknown fields', async () => {
    const app = await appWith();
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Fine', ownerRef: 'someone-else' },
    });
    expect(foreign.statusCode).toBe(400);
    await app.close();
  });

  it('restores the default agent name without losing the owner’s name', async () => {
    const app = await appWith();
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Temporary', ownerName: 'Ijezie' },
    });
    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/agent-profile/name',
      headers: OWNER,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().profile).toMatchObject({
      agentName: DEFAULT_AGENT_NAME,
      ownerName: 'Ijezie',
      isDefault: true,
    });
    await app.close();
  });

  it('does not leak the names into any other surface', async () => {
    const app = await appWith();
    await app.inject({
      method: 'PATCH',
      url: '/api/agent-profile',
      headers: OWNER,
      payload: { agentName: 'Should not travel', ownerName: 'Nobody' },
    });
    const capabilities = await app.inject({ method: 'GET', url: '/api/reasoning' });
    expect(capabilities.body).not.toContain('Should not travel');
    expect(capabilities.body).not.toContain('Nobody');
    await app.close();
  });
});

describe('name normalisation', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normaliseName('  My   Engineer  ', 'agent')).toBe('My Engineer');
  });

  it('keeps accents, emoji and non-Latin scripts intact', () => {
    expect(normaliseName('Ṣẹ́gun Ọ̀gbẹ́ni', 'owner')).toBe('Ṣẹ́gun Ọ̀gbẹ́ni');
    expect(normaliseName('エンジニア', 'agent')).toBe('エンジニア');
    expect(normaliseName('My 🤖', 'agent')).toBe('My 🤖');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(normaliseName('🤖'.repeat(MAX_NAME_LENGTH), 'agent')).toHaveLength(MAX_NAME_LENGTH * 2);
  });
});

describe('agent profile store', () => {
  const fixed = { now: () => new Date('2026-11-02T10:00:00.000Z') };

  it('stamps the change time', () => {
    const store = new AgentProfileStore(fixed);
    expect(store.update('o', { agentName: 'Named' }).updatedAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('drops the oldest owner rather than growing without a bound', () => {
    const store = new AgentProfileStore({ ...fixed, capacity: 2 });
    store.update('a', { agentName: 'A' });
    store.update('b', { agentName: 'B' });
    store.update('c', { agentName: 'C' });
    expect(store.size).toBe(2);
    expect(store.get('a').isDefault).toBe(true);
    expect(store.get('c').agentName).toBe('C');
  });

  it('keeps a renamed owner when it is renamed again', () => {
    const store = new AgentProfileStore({ ...fixed, capacity: 2 });
    store.update('a', { agentName: 'A1' });
    store.update('b', { agentName: 'B' });
    store.update('a', { agentName: 'A2' });
    store.update('c', { agentName: 'C' });
    expect(store.get('a').agentName).toBe('A2');
    expect(store.get('b').isDefault).toBe(true);
  });

  it('forgets an owner entirely once nothing custom remains', () => {
    const store = new AgentProfileStore(fixed);
    store.update('o', { agentName: 'Named' });
    store.resetAgentName('o');
    expect(store.size).toBe(0);
    expect(store.get('o')).toMatchObject({ agentName: DEFAULT_AGENT_NAME, ownerName: null });
  });
});

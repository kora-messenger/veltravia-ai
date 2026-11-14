/**
 * Account operations as chat tools (Step 62).
 *
 * The account agent already answered over `/api/account/...`. This suite is
 * about the other door: the one the model uses when a person types "how many
 * credits have I got left". What has to be true, in order:
 *
 *  - the tools exist for an owner and are listed as tools, not prose;
 *  - calling one reads that owner's real account, through the same tool system
 *    as every other tool (schema first, then the account agent's own checks);
 *  - an action this build cannot do is listed as unavailable, with its reason,
 *    so the assistant can say what is missing instead of implying it worked;
 *  - a sensitive action still stops for a human, and the confirmation a person
 *    gives in the chat is the approval the audit trail records;
 *  - a refusal reaches the caller as a refusal, never as a cheerful result.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountCallRequest, AccountCallOutcome } from '@veltravia/account-agent-core';

import { createAccountTools } from './account-tools.js';
import type { AccountAgentService } from './account-agent-service.js';

const OWNER = 'tools-owner';

/** A stand-in account service that records exactly what it was asked. */
function fakeAccounts(overrides?: { readonly outcome?: Partial<AccountCallOutcome> }): {
  readonly service: AccountAgentService;
  readonly calls: { request: AccountCallRequest; ownerRef: string }[];
} {
  const calls: { request: AccountCallRequest; ownerRef: string }[] = [];
  const service: AccountAgentService = {
    durable: false,
    catalog: () => ({
      durable: false,
      permissions: ['account:read', 'account:write', 'workspace:admin'],
      note: 'fixture',
      tools: [
        {
          name: 'wallet.read',
          title: 'Read the credit balance',
          summary: 'Reads what is left in the wallet.',
          risk: 1,
          permission: 'account:read',
          params: [{ name: 'lane', type: 'enum', values: ['ai', 'integration'], required: true }],
          mutates: false,
          availability: { available: true },
          needsWorkspace: false,
        },
        {
          name: 'allocation.allocate',
          title: 'Allocate credits',
          summary: 'Gives part of the pool to one target.',
          risk: 3,
          permission: 'workspace:admin',
          params: [
            { name: 'targetId', type: 'string', required: true, maxLength: 120 },
            { name: 'credits', type: 'number', required: true, minimum: 1 },
          ],
          mutates: true,
          availability: { available: true },
          needsWorkspace: false,
        },
        {
          name: 'member.invite',
          title: 'Invite a member',
          summary: 'Invites someone into the workspace.',
          risk: 3,
          permission: 'workspace:admin',
          params: [],
          mutates: true,
          availability: {
            available: false,
            reason: 'This build has no workspace membership, so there is nobody to invite.',
          },
          needsWorkspace: false,
        },
      ],
    }),
    call: async (principal, request) => {
      calls.push({ request, ownerRef: principal.ownerRef });
      const base = {
        status: 'executed' as const,
        result: {
          ok: true,
          summary: '1,240 credits left in the AI lane.',
          data: { remaining: 1240 },
        },
        error: null,
        approval: null,
        audit: {
          id: 'aud_1',
          ownerRef: principal.ownerRef,
          tool: request.tool,
        } as unknown as AccountCallOutcome['audit'],
      };
      return { ...base, ...overrides?.outcome } as AccountCallOutcome;
    },
    activity: async () => [],
    entry: async () => null,
  };
  return { service, calls };
}

function managerFor(service: AccountAgentService): {
  bundle: ReturnType<typeof createAccountTools>;
  invoke: (
    id: string,
    input: Record<string, unknown>,
    invitation?: { confirmationId?: string },
  ) => Promise<Record<string, unknown>>;
} {
  const bundle = createAccountTools(service, {
    ownerRef: OWNER,
    sessionId: 'test',
    role: 'owner',
    workspaceId: null,
    operator: false,
  });
  const invoke = async (
    id: string,
    input: Record<string, unknown>,
    invitation?: { confirmationId?: string },
  ) => {
    const implementation = bundle.implementations.find((item) => item.toolId === id);
    if (implementation === undefined) throw new Error(`no implementation for ${id}`);
    return implementation.handler(input, {
      invocation: {
        id: 'invocation-0001',
        toolId: id,
        input,
        requestedAt: new Date(0).toISOString(),
        requester: 'test',
        confirmationState: invitation?.confirmationId === undefined ? 'not_required' : 'approved',
        ...(invitation?.confirmationId === undefined
          ? {}
          : { confirmationId: invitation.confirmationId }),
      },
    });
  };
  return { bundle, invoke };
}

describe('account operations as chat tools', () => {
  let calls: ReturnType<typeof fakeAccounts>['calls'];
  let service: AccountAgentService;

  beforeEach(() => {
    const fake = fakeAccounts();
    calls = fake.calls;
    service = fake.service;
  });

  afterEach(() => {
    calls.length = 0;
  });

  it('declares one tool per account operation, in the account agent’s own vocabulary', () => {
    const { bundle } = managerFor(service);
    const ids = bundle.definitions.map((definition) => definition.id);
    expect(ids).toEqual([
      'account.wallet.read',
      'account.allocation.allocate',
      'account.member.invite',
    ]);

    const read = bundle.definitions.find((definition) => definition.id === 'account.wallet.read');
    expect(read?.riskLevel).toBe('low');
    expect(read?.requiresConfirmation).toBe(false);
    expect(read?.requiredPermissions).toEqual(['account.read']);

    const allocate = bundle.definitions.find(
      (definition) => definition.id === 'account.allocation.allocate',
    );
    // A risk-3 account action is a high-risk tool, so the chat asks before it runs.
    expect(allocate?.riskLevel).toBe('high');
    expect(allocate?.requiresConfirmation).toBe(true);
  });

  it('keeps an operation this build cannot do, disabled and with its reason', () => {
    const { bundle } = managerFor(service);
    const invite = bundle.definitions.find(
      (definition) => definition.id === 'account.member.invite',
    );
    expect(invite?.description).toMatch(/Not available here/);
    expect(invite?.description).toMatch(/membership/);
    expect(bundle.disabled.map((off) => off.id)).toContain('account.member.invite');
  });

  it('reads the account under the bound owner, not an owner the model names', async () => {
    const { invoke } = managerFor(service);
    const output = await invoke('account.wallet.read', { lane: 'ai' });
    expect(output.summary).toBe('1,240 credits left in the AI lane.');
    expect(JSON.parse(String(output.detail))).toEqual({ remaining: 1240 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ownerRef).toBe(OWNER);
    // The owner is never part of the arguments, so it cannot be spoofed.
    expect(calls[0]?.request.args).toEqual({ lane: 'ai' });
  });

  it('carries the chat confirmation into the account audit instead of asking twice', async () => {
    const { invoke } = managerFor(service);
    await invoke(
      'account.allocation.allocate',
      { targetId: 'prj_1', credits: 500 },
      { confirmationId: 'confirm_abc12345' },
    );
    expect(calls[0]?.request.grant).toEqual({
      kind: 'tool_confirmation',
      reference: 'confirm_abc12345',
    });
    // One key per tool invocation: a retried call cannot double the side effect.
    expect(calls[0]?.request.idempotencyKey).toBe('invocation-0001');
  });

  it('reports a refusal as a failure the assistant cannot read as success', async () => {
    const refusing = fakeAccounts({
      outcome: {
        status: 'refused',
        result: null,
        error: { code: 'PERMISSION_DENIED', message: 'That needs workspace admin permission.' },
      },
    });
    const { invoke } = managerFor(refusing.service);
    await expect(
      invoke('account.allocation.allocate', { targetId: 'prj_1', credits: 500 }),
    ).rejects.toThrow(/workspace admin permission/);
  });
});

describe('the chat offers the account tools for the signed-in owner', () => {
  it('lists them from the routing surface, and disables what it cannot do', async () => {
    const { buildApp } = await import('./server.js');
    const app = buildApp({ env: {} as NodeJS.ProcessEnv });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/reasoning',
        headers: { 'x-veltravia-owner-ref': 'capabilities-owner' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        tools: { id: string; available: boolean; riskLevel: string }[];
      };
      const ids = body.tools.map((tool) => tool.id);
      // A real account read is on offer, so "how many credits do I have" is
      // answerable from the account instead of from the model's memory.
      const summary = body.tools.find((tool) => tool.id === 'account.summary');
      expect(summary).toBeDefined();
      expect(summary?.available).toBe(true);

      // A capability this build does not have is listed but not runnable.
      const invite = body.tools.find((tool) => tool.id === 'account.member.invite');
      expect(invite).toBeDefined();
      expect(invite?.available).toBe(false);

      // A workspace-admin action is listed honestly but stays unrunnable here:
      // this surface has no workspace in scope, so it is never granted.
      const allocate = body.tools.find((tool) => tool.id === 'account.allocation.allocate');
      expect(allocate).toBeDefined();
      expect(allocate?.available).toBe(false);
      expect(ids.length).toBeGreaterThan(10);
    } finally {
      await app.close();
    }
    // Building the whole app on a cold module graph takes longer than the default.
  }, 30_000);
});

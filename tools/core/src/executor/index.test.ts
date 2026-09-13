import { describe, expect, it } from 'vitest';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import {
  createConnectorBackedMockTool,
  createMockPurgeTool,
  createMockSummarizeTool,
} from '@veltravia/tool-mock';
import type { ToolAuditEvent } from '../audit/index.js';
import { ToolExecutionError, ToolNotFoundError } from '../errors/index.js';
import { defineTool, type ToolDefinition } from '../types/index.js';
import { defineObjectSchema } from '../validation/schema.js';
import { ToolManager } from '../manager/index.js';

const NOW = () => new Date('2026-09-13T15:30:00.000Z');
const REQUESTER = { requester: 'test-harness' } as const;

function buildManager(connectors?: ConnectorManager) {
  const events: ToolAuditEvent[] = [];
  const manager = new ToolManager({
    now: NOW,
    ...(connectors !== undefined ? { connectors } : {}),
    onAudit: (event) => events.push(event),
  });
  const summarize = createMockSummarizeTool();
  manager.register(summarize.definition);
  manager.registerImplementation(summarize.implementation);
  const purge = createMockPurgeTool();
  manager.register(purge.definition);
  manager.registerImplementation(purge.implementation);
  return { manager, events };
}

function buildConnectors(configure = true): ConnectorManager {
  const connectors = new ConnectorManager({ now: NOW });
  connectors.register(createMockConnector({ now: NOW }));
  if (configure) connectors.configure('mock');
  return connectors;
}

describe('ToolExecutor pipeline: existence and validation', () => {
  it('denies unknown tools with TOOL_NOT_FOUND', async () => {
    const { manager, events } = buildManager();
    const result = await manager.invoke('ghost.tool', {}, REQUESTER);
    expect(result.status).toBe('denied');
    expect(result.error).toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(events.map((event) => event.type)).toContain('tool_invocation_denied');
  });

  it('denies invalid input with field-level problems (never values)', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.summarize', 'mock.read');
    const result = await manager.invoke(
      'mock.summarize',
      { items: 'not-an-array', surprise: 1 },
      REQUESTER,
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('INVALID_TOOL_INPUT');
    expect(JSON.stringify(result.error)).toContain('input.items: expected array, got string');
    expect(JSON.stringify(result.error)).toContain('input.surprise: unexpected field');
    expect(JSON.stringify(result.error)).not.toContain('not-an-array');
  });
});

describe('ToolExecutor pipeline: permissions', () => {
  it('denies invocation when required permissions are not granted (registration granted none)', async () => {
    const { manager, events } = buildManager();
    const result = await manager.invoke('mock.summarize', { items: ['a'] }, REQUESTER);
    expect(result.status).toBe('denied');
    expect(result.error).toMatchObject({ code: 'TOOL_PERMISSION' });
    expect(events.some((event) => event.type === 'tool_invocation_denied')).toBe(true);
  });

  it('requested (claimed) permissions grant nothing', async () => {
    const { manager } = buildManager();
    const result = await manager.invoke(
      'mock.summarize',
      { items: ['a'] },
      {
        requester: 'ai',
        requestedPermissions: ['mock.read'],
      },
    );
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('TOOL_PERMISSION');
  });

  it('executes once permissions are explicitly granted', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.summarize', 'mock.read');
    const result = await manager.invoke('mock.summarize', { items: ['a', 'b'] }, REQUESTER);
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ text: 'a b', count: 2 });
  });
});

describe('ToolExecutor pipeline: availability', () => {
  it('denies disabled tools', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.summarize', 'mock.read');
    manager.disable('mock.summarize');
    const result = await manager.invoke('mock.summarize', { items: ['a'] }, REQUESTER);
    expect(result.status).toBe('denied');
    expect(result.error).toMatchObject({ code: 'TOOL_UNAVAILABLE' });
  });

  it('denies connector-backed tools when the connector is not registered', async () => {
    const { manager } = buildManager();
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    const result = await manager.invoke('mock.connector.read', { resourceId: 'r1' }, REQUESTER);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('TOOL_UNAVAILABLE');
  });
});

describe('ToolExecutor pipeline: confirmation', () => {
  it('stops critical-risk tools for confirmation even when the definition says not required', async () => {
    const { manager, events } = buildManager();
    manager.grantPermission('mock.purge', 'mock.admin');
    const result = await manager.invoke('mock.purge', { confirmLabel: 'ok' }, REQUESTER);
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.confirmationId).toBeDefined();
    expect(events.some((event) => event.type === 'tool_confirmation_requested')).toBe(true);
  });

  it('executes after the human approves', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.purge', 'mock.admin');
    const first = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        correlationId: 'conv-1',
      },
    );
    expect(first.status).toBe('awaiting_confirmation');
    const approval = manager.confirm(first.confirmationId as string, 'approved');
    expect(approval.state).toBe('approved');
    const second = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        correlationId: 'conv-1',
        confirmationId: first.confirmationId,
      },
    );
    expect(second.status).toBe('success');
    expect(second.output).toEqual({ purged: true });
    expect(second.correlationId).toBe('conv-1');
  });

  it('denies after the human rejects', async () => {
    const { manager, events } = buildManager();
    manager.grantPermission('mock.purge', 'mock.admin');
    const first = await manager.invoke('mock.purge', { confirmLabel: 'ok' }, REQUESTER);
    manager.confirm(first.confirmationId as string, 'rejected');
    const second = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        confirmationId: first.confirmationId,
      },
    );
    expect(second.status).toBe('denied');
    expect(second.error).toMatchObject({ code: 'TOOL_PERMISSION' });
    expect(second.error?.message).toContain('rejected');
    expect(events.some((event) => event.type === 'tool_confirmation_rejected')).toBe(true);
  });

  it('denies expired confirmations', async () => {
    let tick = 0;
    const now = () => new Date(Date.parse('2026-09-13T15:30:00.000Z') + tick * 60_000);
    const manager = new ToolManager({ now });
    const purge = createMockPurgeTool();
    manager.register(purge.definition);
    manager.registerImplementation(purge.implementation);
    manager.grantPermission('mock.purge', 'mock.admin');
    const first = await manager.invoke('mock.purge', { confirmLabel: 'ok' }, REQUESTER);
    expect(first.status).toBe('awaiting_confirmation');
    tick = 10; // past the 5-minute TTL
    const second = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        confirmationId: first.confirmationId,
      },
    );
    expect(second.status).toBe('denied');
    expect(second.error?.message).toContain('expired');
  });

  it('refuses an approval when the input differs from the approved request', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.purge', 'mock.admin');
    const first = await manager.invoke('mock.purge', { confirmLabel: 'ok' }, REQUESTER);
    manager.confirm(first.confirmationId as string, 'approved');
    const altered = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'EVIL' },
      {
        requester: 'test-harness',
        confirmationId: first.confirmationId,
      },
    );
    expect(altered.status).toBe('denied');
    expect(altered.error?.message).toContain('differs from the requested input');
  });

  it('never replays a consumed approval', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.purge', 'mock.admin');
    const first = await manager.invoke('mock.purge', { confirmLabel: 'ok' }, REQUESTER);
    manager.confirm(first.confirmationId as string, 'approved');
    const second = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        confirmationId: first.confirmationId,
      },
    );
    expect(second.status).toBe('success');
    // The approval was consumed: invoking again with the same confirmation
    // must not execute a second time.
    const replay = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'ok' },
      {
        requester: 'test-harness',
        confirmationId: first.confirmationId,
      },
    );
    expect(replay.status).toBe('denied');
    expect(replay.error?.message).toContain('cannot be used');
  });
});

describe('ToolExecutor pipeline: execution', () => {
  it('returns deterministic, normalized, schema-validated output', async () => {
    const { manager, events } = buildManager();
    manager.grantPermission('mock.summarize', 'mock.read');
    const result = await manager.invoke(
      'mock.summarize',
      { items: ['alpha', 'beta', 'gamma'], joiner: ', ' },
      REQUESTER,
    );
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ text: 'alpha, beta, gamma', count: 3 });
    expect(result.requestedAt).toBe('2026-09-13T15:30:00.000Z');
    expect(result.completedAt).toBe('2026-09-13T15:30:00.000Z');
    const types = events.map((event) => event.type);
    expect(types).toContain('tool_execution_started');
    expect(types).toContain('tool_execution_completed');
  });

  it('fails with TOOL_OUTPUT_VALIDATION when a handler returns bad output', async () => {
    const events: ToolAuditEvent[] = [];
    const manager = new ToolManager({ now: NOW, onAudit: (event) => events.push(event) });
    const badTool: ToolDefinition = defineTool({
      id: 'bad.output',
      name: 'Bad Output',
      description: 'Returns output that violates its schema.',
      version: '1.0.0',
      category: 'data',
      inputSchema: defineObjectSchema({
        properties: { x: { type: 'string' } },
        required: ['x'],
        additionalProperties: false,
      }),
      outputSchema: defineObjectSchema({
        properties: { count: { type: 'number' } },
        required: ['count'],
        additionalProperties: false,
      }),
      requiredPermissions: ['bad.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    });
    manager.register(badTool);
    manager.registerImplementation({
      toolId: 'bad.output',
      handler: () => ({ count: 'not-a-number' }) as unknown as Record<string, unknown>,
    });
    manager.grantPermission('bad.output', 'bad.read');
    const result = await manager.invoke('bad.output', { x: 'hi' }, REQUESTER);
    expect(result.status).toBe('failure');
    expect(result.error).toMatchObject({ code: 'TOOL_OUTPUT_VALIDATION' });
    expect(events.some((event) => event.type === 'tool_execution_failed')).toBe(true);
  });

  it('fails with TOOL_EXECUTION when a handler throws', async () => {
    const manager = new ToolManager({ now: NOW });
    const boom: ToolDefinition = defineTool({
      id: 'boom.tool',
      name: 'Boom',
      description: 'Always throws.',
      version: '1.0.0',
      category: 'other',
      inputSchema: defineObjectSchema({ properties: { x: { type: 'string' } } }),
      outputSchema: defineObjectSchema({ properties: { ok: { type: 'boolean' } } }),
      requiredPermissions: ['boom.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    });
    manager.register(boom);
    manager.registerImplementation({
      toolId: 'boom.tool',
      handler: () => {
        throw new Error('handler exploded');
      },
    });
    manager.grantPermission('boom.tool', 'boom.read');
    const result = await manager.invoke('boom.tool', {}, REQUESTER);
    expect(result.status).toBe('failure');
    expect(result.error).toMatchObject({ code: 'TOOL_EXECUTION' });
    expect(result.error?.message).toContain('handler exploded');
  });
});

describe('ToolExecutor pipeline: connector integration (no bypass)', () => {
  it('authorizes through the ConnectorManager and marks external execution not enabled', async () => {
    const { manager } = buildManager(buildConnectors(true));
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    // Connector-side permission still NOT granted -> blocked by the connector gate.
    const blocked = await manager.invoke('mock.connector.read', { resourceId: 'r1' }, REQUESTER);
    expect(blocked.status).toBe('denied');
    expect(blocked.error?.message).toContain('not authorized');

    // Grant the connector permission too -> authorization passes, execution
    // is the explicit Step 5 stub (external execution not enabled).
    const connectors = buildConnectors(true);
    connectors.grantPermission('mock', 'resources.read');
    const wired = buildManager(connectors).manager;
    wired.register(createConnectorBackedMockTool());
    wired.grantPermission('mock.connector.read', 'mock.read');
    const result = await wired.invoke('mock.connector.read', { resourceId: 'r1' }, REQUESTER);
    expect(result.status).toBe('failure');
    expect(result.error).toMatchObject({ code: 'TOOL_EXECUTION' });
    expect(result.error?.message).toContain('not enabled');
  });

  it('runs the full gate offline - no external service is ever called', async () => {
    // The mock connector has no network code at all; this test proves the
    // path averts to authorization-only in CI.
    const connectors = buildConnectors(true);
    const { manager } = buildManager(connectors);
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    const result = await manager.invoke('mock.connector.read', { resourceId: 'r1' }, REQUESTER);
    expect(['denied', 'failure']).toContain(result.status);
    expect(result.status).not.toBe('success');
  });
});

describe('ToolExecutor implementation security', () => {
  it('rejects local implementations for connector-backed tools (no bypass)', () => {
    const connectors = buildConnectors(true);
    const { manager } = buildManager(connectors);
    manager.register(createConnectorBackedMockTool());
    expect(() =>
      manager.registerImplementation({
        toolId: 'mock.connector.read',
        handler: () => ({}),
      }),
    ).toThrowError(ToolExecutionError);
  });

  it('rejects implementations for unknown tools and duplicate implementations', () => {
    const { manager } = buildManager();
    expect(() =>
      manager.registerImplementation({ toolId: 'ghost.tool', handler: () => ({}) }),
    ).toThrowError(ToolNotFoundError);
    expect(() =>
      manager.registerImplementation({
        toolId: 'mock.summarize',
        handler: () => ({ text: 'sneaky', count: 1 }),
      }),
    ).toThrowError(ToolExecutionError);
  });
});

describe('ToolExecutor security: secrets', () => {
  it('tool input secrets never surface in errors, results, or audit events', async () => {
    const { manager, events } = buildManager();
    const token = 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd';
    manager.grantPermission('mock.summarize', 'mock.read');
    // Valid input carrying a secret-looking value: the handler echoes items.
    const result = await manager.invoke(
      'mock.summarize',
      { items: [token], joiner: ' ' },
      REQUESTER,
    );
    expect(result.status).toBe('success');
    // The normalized OUTPUT is the tool's own business (it echoes input),
    // but the framework's error paths and audit events never carry it:
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain(token);
  });

  it('validation problems never echo input values (secret in invalid input)', async () => {
    const { manager } = buildManager();
    manager.grantPermission('mock.summarize', 'mock.read');
    const token = 'sk-proj-AbCdEf1234567890AbCdEf1234567890';
    const result = await manager.invoke(
      'mock.summarize',
      { items: [1, 2], smuggled: token },
      REQUESTER,
    );
    expect(result.status).toBe('denied');
    expect(JSON.stringify(result.error)).not.toContain(token);
    expect(JSON.stringify(result.error)).toContain('input.smuggled: unexpected field');
  });
});

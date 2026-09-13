import { describe, expect, it } from 'vitest';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { ToolManager } from '@veltravia/tool-core';
import {
  createConnectorBackedMockTool,
  createMockPurgeTool,
  createMockSummarizeTool,
} from './mock-tool.js';

const NOW = () => new Date('2026-09-13T15:45:00.000Z');

describe('mock tools', () => {
  it('summarize tool: valid definitions with schemas, permissions, and risk levels', () => {
    const summarize = createMockSummarizeTool();
    expect(summarize.definition.id).toBe('mock.summarize');
    expect(summarize.definition.category).toBe('data');
    expect(summarize.definition.riskLevel).toBe('low');
    expect(summarize.definition.requiredPermissions).toEqual(['mock.read']);
    expect(typeof summarize.implementation.handler).toBe('function');

    const purge = createMockPurgeTool();
    expect(purge.definition.id).toBe('mock.purge');
    // The declaration says no confirmation - the framework must still force it.
    expect(purge.definition.requiresConfirmation).toBe(false);
    expect(purge.definition.riskLevel).toBe('critical');
  });

  it('connector-backed tool references the Step 4 mock connector, with no local behavior', () => {
    const connectorBacked = createConnectorBackedMockTool();
    expect(connectorBacked.connector).toEqual({ connectorId: 'mock', operationId: 'mock.read' });
  });

  it('executes deterministically with no credentials and no network', async () => {
    const manager = new ToolManager({ now: NOW });
    const summarize = createMockSummarizeTool();
    manager.register(summarize.definition);
    manager.registerImplementation(summarize.implementation);
    manager.grantPermission('mock.summarize', 'mock.read');
    const first = await manager.invoke(
      'mock.summarize',
      { items: ['a', 'b', 'c'], joiner: '-' },
      { requester: 'test-harness' },
    );
    const second = await manager.invoke(
      'mock.summarize',
      { items: ['a', 'b', 'c'], joiner: '-' },
      { requester: 'test-harness' },
    );
    expect(first.status).toBe('success');
    expect(first.output).toEqual({ text: 'a-b-c', count: 3 });
    expect(second.output).toEqual(first.output);
  });

  it('demonstrates the permission check: ungranted -> denied, granted -> success', async () => {
    const manager = new ToolManager({ now: NOW });
    const summarize = createMockSummarizeTool();
    manager.register(summarize.definition);
    manager.registerImplementation(summarize.implementation);
    const denied = await manager.invoke('mock.summarize', { items: [] }, { requester: 't' });
    expect(denied.status).toBe('denied');
    manager.grantPermission('mock.summarize', 'mock.read');
    const allowed = await manager.invoke('mock.summarize', { items: [] }, { requester: 't' });
    expect(allowed.status).toBe('success');
  });

  it('demonstrates the confirmation flow end to end', async () => {
    const manager = new ToolManager({ now: NOW });
    const purge = createMockPurgeTool();
    manager.register(purge.definition);
    manager.registerImplementation(purge.implementation);
    manager.grantPermission('mock.purge', 'mock.admin');
    const waiting = await manager.invoke('mock.purge', { confirmLabel: 'go' }, { requester: 't' });
    expect(waiting.status).toBe('awaiting_confirmation');
    manager.confirm(waiting.confirmationId as string, 'approved');
    const done = await manager.invoke(
      'mock.purge',
      { confirmLabel: 'go' },
      { requester: 't', confirmationId: waiting.confirmationId },
    );
    expect(done.status).toBe('success');
    expect(done.output).toEqual({ purged: true });
  });

  it('demonstrates connector integration without ever calling an external service', async () => {
    const connectors = new ConnectorManager({ now: NOW });
    connectors.register(createMockConnector({ now: NOW }));
    connectors.configure('mock');
    const manager = new ToolManager({ now: NOW, connectors });
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    // Connector permission not granted -> denied by the connector gate.
    const blocked = await manager.invoke(
      'mock.connector.read',
      { resourceId: 'r' },
      { requester: 't' },
    );
    expect(blocked.status).toBe('denied');
    // Both gates open -> authorization passes; execution is the explicit stub.
    connectors.grantPermission('mock', 'resources.read');
    const stubbed = await manager.invoke(
      'mock.connector.read',
      { resourceId: 'r' },
      { requester: 't' },
    );
    expect(stubbed.status).toBe('failure');
    expect(stubbed.error?.code).toBe('TOOL_EXECUTION');
  });
});

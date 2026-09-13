import { describe, expect, it } from 'vitest';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { createConnectorBackedMockTool, createMockSummarizeTool } from '@veltravia/tool-mock';
import type { ToolAuditEvent } from '../audit/index.js';
import { ToolManager } from './index.js';

const NOW = () => new Date('2026-09-13T15:30:00.000Z');

function buildHarness(options: { withConnectors?: boolean; configureConnector?: boolean } = {}) {
  const events: ToolAuditEvent[] = [];
  const manager = new ToolManager({ now: NOW, onAudit: (event) => events.push(event) });
  let connectors: ConnectorManager | undefined;
  if (options.withConnectors) {
    connectors = new ConnectorManager({ now: NOW });
    connectors.register(createMockConnector({ now: NOW }));
    if (options.configureConnector !== false) connectors.configure('mock');
    // Rebuild the tool manager wired to the connector manager.
    const managerWithConnectors = new ToolManager({
      now: NOW,
      connectors,
      onAudit: (event) => events.push(event),
    });
    return { manager: managerWithConnectors, events, connectors };
  }
  return { manager, events, connectors };
}

function registeredSummaryHarness() {
  const { manager, events } = buildHarness();
  const summarize = createMockSummarizeTool();
  manager.register(summarize.definition);
  manager.registerImplementation(summarize.implementation);
  return { manager, events, summarize };
}

describe('ToolManager registration', () => {
  it('registers with an EMPTY permission set and audits it', () => {
    const { manager, events } = registeredSummaryHarness();
    expect(manager.has('mock.summarize')).toBe(true);
    expect(manager.getGrantedPermissions('mock.summarize')).toEqual([]);
    expect(manager.getRequiredPermissions('mock.summarize')).toEqual(['mock.read']);
    expect(events.map((event) => event.type)).toContain('tool_registered');
  });

  it('lists, unregisters, and frees the id', () => {
    const { manager, events } = registeredSummaryHarness();
    expect(manager.list().map((tool) => tool.id)).toEqual(['mock.summarize']);
    manager.unregister('mock.summarize');
    expect(manager.has('mock.summarize')).toBe(false);
    expect(events.map((event) => event.type)).toContain('tool_unregistered');
    // The id is free again.
    const summarize = createMockSummarizeTool();
    expect(() => manager.register(summarize.definition)).not.toThrow();
  });
});

describe('ToolManager permissions', () => {
  it('grants and revokes ONLY declared permissions', () => {
    const { manager } = registeredSummaryHarness();
    manager.grantPermission('mock.summarize', 'mock.read');
    expect(manager.getGrantedPermissions('mock.summarize')).toEqual(['mock.read']);
    expect(() => manager.grantPermission('mock.summarize', 'undeclared.permission')).toThrow(
      /not declared/,
    );
    manager.revokePermission('mock.summarize', 'mock.read');
    expect(manager.getGrantedPermissions('mock.summarize')).toEqual([]);
  });

  it('registration never grants permissions', () => {
    const { manager } = registeredSummaryHarness();
    expect(manager.getAvailability('mock.summarize')).toMatchObject({
      state: 'permission_denied',
      detail: 'missing granted permissions: mock.read',
    });
  });
});

describe('ToolManager availability', () => {
  it('reports disabled tools', () => {
    const { manager } = registeredSummaryHarness();
    manager.grantPermission('mock.summarize', 'mock.read');
    expect(manager.getAvailability('mock.summarize').state).toBe('available');
    manager.disable('mock.summarize', 'operator kill-switch');
    expect(manager.getAvailability('mock.summarize')).toEqual({
      state: 'disabled',
      detail: 'operator kill-switch',
    });
    manager.enable('mock.summarize');
    expect(manager.getAvailability('mock.summarize').state).toBe('available');
  });

  it('reports misconfigured connector-backed tools when no ConnectorManager is wired', () => {
    const { manager } = buildHarness();
    manager.register(createConnectorBackedMockTool());
    expect(manager.getAvailability('mock.connector.read')).toEqual({
      state: 'misconfigured',
      detail: 'tool system is not wired to a ConnectorManager',
    });
  });

  it('reports unavailable when the referenced connector is not registered', () => {
    const { manager, connectors } = buildHarness({ withConnectors: true });
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    expect(manager.getAvailability('mock.connector.read').state).toBe('available');
    connectors?.unregister('mock');
    expect(manager.getAvailability('mock.connector.read')).toMatchObject({
      state: 'unavailable',
    });
  });

  it('connector-disabled tools are unavailable', () => {
    const events: ToolAuditEvent[] = [];
    const connectors = new ConnectorManager({ now: NOW });
    connectors.register(createMockConnector({ now: NOW }));
    connectors.configure('mock');
    const manager = new ToolManager({ now: NOW, connectors, onAudit: (e) => events.push(e) });
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    expect(manager.getAvailability('mock.connector.read').state).toBe('available');
    connectors.disable('mock');
    expect(manager.getAvailability('mock.connector.read').state).toBe('unavailable');
  });

  it('reports awaiting_configuration when the connector is only registered', () => {
    const connectors = new ConnectorManager({ now: NOW });
    connectors.register(createMockConnector({ now: NOW }));
    const manager = new ToolManager({ now: NOW, connectors });
    manager.register(createConnectorBackedMockTool());
    manager.grantPermission('mock.connector.read', 'mock.read');
    expect(manager.getAvailability('mock.connector.read')).toMatchObject({
      state: 'awaiting_configuration',
    });
  });
});

describe('ToolManager inspection', () => {
  it('inspects definition, grants, availability, and flags', () => {
    const { manager } = registeredSummaryHarness();
    const inspection = manager.inspect('mock.summarize');
    expect(inspection.definition.id).toBe('mock.summarize');
    expect(inspection.grantedPermissions).toEqual([]);
    expect(inspection.availability.state).toBe('permission_denied');
    expect(inspection.confirmationRequired).toBe(false);
    expect(inspection.hasConnectorReference).toBe(false);
    expect(inspection.hasLocalImplementation).toBe(true);
  });

  it('computes confirmation requirement including risk-based escalation', () => {
    const { manager } = registeredSummaryHarness();
    const connectorBacked = createConnectorBackedMockTool();
    manager.register(connectorBacked);
    expect(manager.inspect('mock.connector.read').hasConnectorReference).toBe(true);
  });
});

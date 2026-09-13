import { describe, expect, it } from 'vitest';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { ToolManager } from '@veltravia/tool-core';
import { createConnectorBackedMockTool, createMockSummarizeTool } from '@veltravia/tool-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-09-13T15:30:00.000Z');

function buildToolApp(): ReturnType<typeof buildApp> {
  const connectors = new ConnectorManager({ now: NOW });
  connectors.register(createMockConnector({ now: NOW }));
  connectors.configure('mock');
  const manager = new ToolManager({ now: NOW, connectors });
  const summarize = createMockSummarizeTool();
  manager.register(summarize.definition);
  manager.registerImplementation(summarize.implementation);
  manager.register(createConnectorBackedMockTool());
  return buildApp({ tools: manager });
}

describe('GET /api/tools', () => {
  it('lists registered tools with safe metadata only', async () => {
    const app = buildToolApp();
    const response = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tools).toHaveLength(2);
    const summarize = body.tools[0];
    expect(summarize).toMatchObject({
      id: 'mock.summarize',
      name: 'Summarize Items',
      category: 'data',
      requiredPermissions: ['mock.read'],
      riskLevel: 'low',
      confirmationRequired: false,
      availability: 'permission_denied',
    });
    const connectorBacked = body.tools[1];
    expect(connectorBacked).toMatchObject({
      id: 'mock.connector.read',
      connector: { connectorId: 'mock', operationId: 'mock.read' },
      availability: 'permission_denied',
    });
    app.close();
  });

  it('contains no credential or token material anywhere in the payload', async () => {
    const app = buildToolApp();
    const response = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(response.body).not.toMatch(/AIza|ghp_|sk-|Bearer\s|password|secret/i);
    app.close();
  });
});

describe('GET /api/tools/:id', () => {
  it('returns the safe inspection for a known tool', async () => {
    const app = buildToolApp();
    const response = await app.inject({ method: 'GET', url: '/api/tools/mock.summarize' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.definition).toMatchObject({
      id: 'mock.summarize',
      version: '1.0.0',
      category: 'data',
      riskLevel: 'low',
    });
    expect(body.requiredPermissions).toEqual(['mock.read']);
    expect(body.grantedPermissions).toEqual([]);
    expect(body.confirmationRequired).toBe(false);
    expect(body.availability).toMatchObject({ state: 'permission_denied' });
    expect(body.hasLocalImplementation).toBe(true);
    expect(body.hasConnectorReference).toBe(false);
    app.close();
  });

  it('404s with a typed error for unknown tools', async () => {
    const app = buildToolApp();
    const response = await app.inject({ method: 'GET', url: '/api/tools/ghost.tool' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'TOOL_NOT_FOUND',
        message: 'No tool registered with id "ghost.tool".',
        details: { toolId: 'ghost.tool' },
      },
    });
    app.close();
  });
});

/**
 * The billing seam between the integration runtime and the credit system
 * (Step 56).
 *
 * The service tests prove what a charge does. This proves where it happens: one
 * call to the gate per executed connector operation, carrying the identifiers a
 * person could check, and a refusal that stops the operation instead of letting
 * it run for free.
 *
 * The gate here is a recorder, so these assertions are about the seam and not
 * about money; the money assertions live in the service tests.
 */

import { describe, expect, it } from 'vitest';

import type { ToolDefinition, ToolObjectSchema } from '@veltravia/tool-core';

import { createGitHubApiConnector } from './github.js';
import { createIntegrationSystem } from './integrations.js';
import type {
  IntegrationBillingGate,
  IntegrationChargeContext,
} from './integration-credit-service.js';

const OBJECT_SCHEMA = {
  type: 'object',
  properties: { connectionId: { type: 'string' } },
  additionalProperties: true,
} as ToolObjectSchema;

const readTool: ToolDefinition = {
  id: 'mock-storage.objects.read',
  name: 'Read object',
  description: 'Reads one object from the offline mock storage.',
  version: '1.0.0',
  category: 'storage',
  inputSchema: {
    type: 'object',
    properties: {
      connectionId: { type: 'string' },
      objectId: { type: 'string' },
    },
    required: ['connectionId', 'objectId'],
    additionalProperties: false,
  } as ToolObjectSchema,
  outputSchema: OBJECT_SCHEMA,
  requiredPermissions: ['storage.objects.read'],
  connector: { connectorId: 'mock-storage', operationId: 'storage.objects.get' },
  integrationId: 'mock-storage',
  riskLevel: 'low',
  requiresConfirmation: false,
};

function system(gate: IntegrationBillingGate | null) {
  return createIntegrationSystem({
    now: () => new Date('2026-11-12T06:00:00.000Z'),
    github: createGitHubApiConnector({ now: () => new Date('2026-11-12T06:00:00.000Z') }),
    billing: () => gate,
  });
}

interface Recorded {
  context: IntegrationChargeContext;
  ran: boolean;
}

function recorder(options: { refuse?: boolean } = {}): {
  gate: IntegrationBillingGate;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const gate: IntegrationBillingGate = {
    async bill(context, run) {
      const record: Recorded = { context, ran: false };
      calls.push(record);
      if (options.refuse === true) {
        throw Object.assign(new Error('The wallet cannot cover this operation.'), {
          code: 'INSUFFICIENT_CREDITS',
          status: 402,
        });
      }
      const result = await run();
      record.ran = true;
      return result;
    },
  };
  return { gate, calls };
}

const connection = (integrations: ReturnType<typeof system>): string => {
  const demo = integrations.demoConnections['mock-storage'];
  if (demo === undefined) throw new Error('the mock storage connection was not seeded');
  return demo.connectionId;
};

describe('the connector billing seam', () => {
  it('bills one executed operation with the identifiers a person can check', async () => {
    const { gate, calls } = recorder();
    const integrations = system(gate);
    const executor = integrations.connectorExecutor();
    const output = await executor.executeConnectorOperation(
      readTool,
      { connectionId: connection(integrations), objectId: 'demo/readme.md' },
      { invocationId: 'inv-42', correlationId: 'run-42', ownerRef: 'owner-42' },
    );
    expect(output).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ran).toBe(true);
    expect(calls[0]?.context).toMatchObject({
      ownerRef: 'owner-42',
      kind: 'integration.operation',
      integrationId: 'mock-storage',
      connectorId: 'mock-storage',
      operationId: 'storage.objects.get',
      requestId: 'inv-42',
      executionId: 'run-42',
    });
    expect(calls[0]?.context.connectionId).toBe(connection(integrations));
  });

  it('never runs the operation when the gate refuses', async () => {
    const { gate, calls } = recorder({ refuse: true });
    const integrations = system(gate);
    await expect(
      integrations.connectorExecutor().executeConnectorOperation(readTool, {
        connectionId: connection(integrations),
        objectId: 'demo/readme.md',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ran).toBe(false);
  });

  it('charges nothing when the deployment has no credit gate', async () => {
    const integrations = system(null);
    const output = await integrations.connectorExecutor().executeConnectorOperation(readTool, {
      connectionId: connection(integrations),
      objectId: 'demo/readme.md',
    });
    expect(output).toBeTruthy();
  });

  it('files the charge under the integration owner when the caller names none', async () => {
    const { gate, calls } = recorder();
    const integrations = system(gate);
    await integrations.connectorExecutor().executeConnectorOperation(readTool, {
      connectionId: connection(integrations),
      objectId: 'demo/readme.md',
    });
    expect(calls[0]?.context.ownerRef).toBe(integrations.owner.id);
  });
});

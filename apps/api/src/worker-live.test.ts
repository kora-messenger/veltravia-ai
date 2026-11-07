/**
 * The opt-in live check: a real provider, a real model, a real file.
 *
 * Skipped unless VELTRAVIA_LIVE_WORKER=1 and a provider key plus
 * VELTRAVIA_CREDENTIAL_KEY are present, so CI stays deterministic and free.
 * When it runs it proves the whole chain end to end: gateway credential, router
 * choice, model turn, authorised tool, written file, usage recorded.
 */

import { describe, expect, it } from 'vitest';

import { validAssignment } from '@veltravia/worker-core';
import { createGatewayService } from './ai-gateway-service.js';
import { createWorkerExecutor } from './worker-execution.js';

const enabled = process.env['VELTRAVIA_LIVE_WORKER'] === '1';
const key = process.env['GROQ_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
const encryptionReady = (process.env['VELTRAVIA_CREDENTIAL_KEY'] ?? '').length > 0;
const canRun = enabled && key !== undefined && encryptionReady;

function memoryEngine() {
  const files = new Map<string, string>([
    ['src/greeting.ts', 'export function greeting(): string {\n  return "hello";\n}\n'],
  ]);
  const engine = {
    projects: {},
    workspaces: { listWorkspaces: async () => [{ id: 'ws_live', status: 'active' }] },
    files: {
      listAll: async () =>
        Array.from(files.keys()).map((path) => ({
          path,
          type: 'file',
          revision: 1,
          updatedAt: 'now',
        })),
      readFile: async (_id: string, path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error('not found');
        return { node: { path, revision: 1 }, content };
      },
      createFile: async (_id: string, input: { path: string; content: string }) => {
        files.set(input.path, input.content);
        return { path: input.path, revision: 1 };
      },
      updateFile: async (_id: string, path: string, input: { content: string }) => {
        files.set(path, input.content);
        return { path, revision: 2 };
      },
      createDirectory: async () => ({ path: 'src', type: 'directory' }),
    },
  } as never;
  return { engine, files };
}

describe.skipIf(!canRun)('a real model-powered worker', () => {
  it('reads a file, writes a bound change and reports usage', async () => {
    const service = createGatewayService({ env: process.env });
    if (service.gateway === null) throw new Error(service.blockedReason);
    const provider = process.env['GROQ_API_KEY'] === undefined ? 'openrouter' : 'groq';
    const connection = await service.gateway.createConnection(
      { ownerRef: 'live-owner' } as never,
      {
        providerId: provider,
        label: 'live worker check',
        apiKey: key as string,
      } as never,
    );
    expect(connection.id).toBeTruthy();
    const { engine, files } = memoryEngine();
    const executor = createWorkerExecutor({ gateway: service, engine, mode: 'model' });
    const result = await executor.run({
      workerId: 'wkr_live',
      ownerRef: 'live-owner',
      taskId: 'task_live',
      projectId: 'prj_live',
      workerType: 'documentation' as never,
      assignment: validAssignment({
        objective: 'Document greeting() from src/greeting.ts in src/notes.md',
        scope: ['src'],
        allowedTools: ['project.read', 'docs.write'],
        deliverables: [
          { name: 'notes', kind: 'report', path: 'src/notes.md', description: 'notes' },
        ],
        acceptanceCriteria: ['src/notes.md explains greeting()'],
        limits: { maxDurationMs: 60_000, maxToolCalls: 6, maxDeliverables: 2 },
      }),
      signal: new AbortController().signal,
      report: (event) => console.log('PROGRESS', event.message),
    });
    console.log('RESULT', JSON.stringify(result, null, 2));
    expect(result.usage?.live).toBe(true);
    expect(result.usage?.modelCalls).toBeGreaterThan(0);
    expect(files.get('src/notes.md')?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * Offline tests for the GitHub connector. NOTHING here touches the network,
 * real credentials, or the host filesystem - every request runs against the
 * deterministic fake transport. Security invariants (scope enforcement,
 * path safety, secret scrubbing, revision protection) are asserted directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ConnectorManager } from '@veltravia/connector-core';
import { ToolManager, type ToolDefinition } from '@veltravia/tool-core';
import {
  FakeGitHubTransport,
  createFakeRepository,
  createGitHubConnectorRuntime,
  createGitHubOperationExecutor,
  createGitHubToolDefinitions,
  GITHUB_CONNECTOR_ID,
  GitHubError,
  type GitHubAuditEvent,
  type GitHubConnectionScope,
} from './index.js';

const NOW = () => new Date('2026-09-14T12:00:00.000Z');

function scope(
  overrides: Partial<GitHubConnectionScope['repositories'][number]> = {},
): GitHubConnectionScope {
  return {
    repositories: [
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        defaultBranch: 'main',
        ...overrides,
      },
    ],
  };
}

interface TestHarness {
  readonly transport: FakeGitHubTransport;
  readonly runtime: ReturnType<typeof createGitHubConnectorRuntime>;
  readonly events: GitHubAuditEvent[];
}

function buildHarness(
  overrides: {
    scope?: GitHubConnectionScope;
    transport?: FakeGitHubTransport;
  } = {},
): TestHarness {
  const transport =
    overrides.transport ??
    new FakeGitHubTransport({
      state: {
        repositories: [
          createFakeRepository({
            owner: 'veltravia-demo',
            name: 'fixture-repo',
            description: 'offline fixture repository',
            files: {
              'README.md': '# Fixture repository\n\nOffline content.',
              'src/index.ts': 'export const value = 1;\n',
            },
          }),
          createFakeRepository({ owner: 'veltravia-demo', name: 'other-repo' }),
        ],
      },
    });
  const events: GitHubAuditEvent[] = [];
  const runtime = createGitHubConnectorRuntime({
    connectorId: GITHUB_CONNECTOR_ID,
    connectionId: 'github-connection:fixture',
    scope: overrides.scope ?? scope(),
    transport,
    credentialProviderRef: 'env:GITHUB_DEMO_TOKEN',
    now: NOW,
    onAudit: (event) => {
      events.push(event);
    },
  });
  return { transport, runtime, events };
}

describe('GitHub connector runtime (offline fake transport)', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('rejects operations before the connection is established (defense in depth)', async () => {
    await expect(
      harness.runtime.executeOperation('github.repositories.list', {}),
    ).rejects.toThrowError(/not established/i);
  });

  it('lists only the scoped repositories (scope is the boundary)', async () => {
    await harness.runtime.connector.connect();
    const result = await harness.runtime.executeOperation('github.repositories.list', {});
    const repositories = result.repositories as { owner: string; repository: string }[];
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.owner).toBe('veltravia-demo');
    expect(repositories[0]?.repository).toBe('fixture-repo');
  });

  it('honors the optional search filter inside the scope only', async () => {
    await harness.runtime.connector.connect();
    const result = await harness.runtime.executeOperation('github.repositories.list', {
      search: 'fixture',
    });
    const repositories = result.repositories as { owner: string; repository: string }[];
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.repository).toBe('fixture-repo');
    // A filter matching nothing scoped returns an empty list, never
    // out-of-scope repositories.
    const empty = await harness.runtime.executeOperation('github.repositories.list', {
      search: 'other',
    });
    expect((empty.repositories as unknown[]).length).toBe(0);
  });

  it('reads a file and returns decoded untrusted content', async () => {
    await harness.runtime.connector.connect();
    const result = await harness.runtime.executeOperation('github.contents.get', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'README.md',
      branch: 'main',
    });
    expect(result.path).toBe('README.md');
    expect(result.content).toBe('# Fixture repository\n\nOffline content.');
    expect(typeof result.sha).toBe('string');
  });

  it('lists the root directory with files and directories', async () => {
    await harness.runtime.connector.connect();
    const result = await harness.runtime.executeOperation('github.contents.list', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: '',
      branch: 'main',
    });
    const entries = result.entries as { name: string; type: string }[];
    expect(entries.map((entry) => `${entry.type}:${entry.name}`).sort()).toEqual([
      'dir:src',
      'file:README.md',
    ]);
  });

  it('creates a file as a single commit when no sha is supplied', async () => {
    await harness.runtime.connector.connect();
    const result = await harness.runtime.executeOperation('github.contents.create-or-update', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'docs/guide.md',
      branch: 'main',
      message: 'Add guide',
      content: '# Guide\n',
    });
    const commit = result.commit as { path: string; message: string };
    expect(commit.path).toBe('docs/guide.md');
    expect(commit.message).toBe('Add guide');
    // The file is now readable with the exact content written.
    const read = await harness.runtime.executeOperation('github.contents.get', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'docs/guide.md',
      branch: 'main',
    });
    expect(read.content).toBe('# Guide\n');
  });

  it('updates require the sha of the version last read (revision protection)', async () => {
    await harness.runtime.connector.connect();
    // An update with NO sha on an existing file is rejected: no blind overwrite.
    await expect(
      harness.runtime.executeOperation('github.contents.create-or-update', {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
        message: 'Update readme',
        content: 'changed',
      }),
    ).rejects.toThrowError(/sha was not provided/i);
    // An update with a STALE sha is a conflict, not an overwrite.
    await expect(
      harness.runtime.executeOperation('github.contents.create-or-update', {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
        message: 'Update readme',
        content: 'changed',
        expectedSha: '0'.repeat(40),
      }),
    ).rejects.toThrowError(/changed since it was read/i);
    // A correct sha wins and returns a commit.
    const read = await harness.runtime.executeOperation('github.contents.get', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'README.md',
      branch: 'main',
    });
    const updated = await harness.runtime.executeOperation('github.contents.create-or-update', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'README.md',
      branch: 'main',
      message: 'Update readme',
      content: 'updated',
      expectedSha: read.sha,
    });
    expect((updated.commit as { message: string }).message).toBe('Update readme');
  });

  it('deletes require the sha of the version last read', async () => {
    await harness.runtime.connector.connect();
    const read = await harness.runtime.executeOperation('github.contents.get', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'src/index.ts',
      branch: 'main',
    });
    await expect(
      harness.runtime.executeOperation('github.contents.delete', {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'src/index.ts',
        branch: 'main',
        message: 'Remove file',
        sha: '0'.repeat(40),
      }),
    ).rejects.toThrowError(/changed since it was read/i);
    const result = await harness.runtime.executeOperation('github.contents.delete', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      path: 'src/index.ts',
      branch: 'main',
      message: 'Remove file',
      sha: read.sha,
    });
    expect((result.commit as { message: string }).message).toBe('Remove file');
    // Gone: subsequent reads are an honest NOT_FOUND.
    await expect(
      harness.runtime.executeOperation('github.contents.get', {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'src/index.ts',
        branch: 'main',
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it('creates branches and refuses duplicates with honest errors', async () => {
    await harness.runtime.connector.connect();
    const main = (await harness.runtime.executeOperation('github.branches.get', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      branch: 'main',
    })) as { name: string; sha: string };
    const created = (await harness.runtime.executeOperation('github.branches.create', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
      branch: 'feature/demo',
      fromSha: main.sha,
    })) as { name: string; sha: string };
    expect(created.name).toBe('feature/demo');
    // A duplicate branch is an honest VALIDATION error.
    let caught: unknown;
    try {
      await harness.runtime.executeOperation('github.branches.create', {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        branch: 'feature/demo',
        fromSha: main.sha,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as GitHubError).code).toBe('GITHUB_VALIDATION');
    const branches = (await harness.runtime.executeOperation('github.branches.list', {
      owner: 'veltravia-demo',
      repository: 'fixture-repo',
    })) as { branches: { name: string }[] };
    expect(branches.branches.map((branch) => branch.name).sort()).toEqual(['feature/demo', 'main']);
  });

  it('denies out-of-scope repositories before any request reaches the network', async () => {
    await harness.runtime.connector.connect();
    const before = harness.transport.requests.length;
    let caught: unknown;
    try {
      await harness.runtime.executeOperation('github.contents.get', {
        owner: 'veltravia-demo',
        repository: 'other-repo',
        path: 'README.md',
        branch: 'main',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as GitHubError).code).toBe('GITHUB_SCOPE_DENIED');
    expect(harness.transport.requests.length).toBe(before);
  });

  it('denies traversal and absolute paths (path safety, typed errors)', async () => {
    await harness.runtime.connector.connect();
    const before = harness.transport.requests.length;
    for (const path of ['../secrets', '/etc/passwd', 'a/../../b', 'src/../../etc']) {
      let caught: unknown;
      try {
        await harness.runtime.executeOperation('github.contents.get', {
          owner: 'veltravia-demo',
          repository: 'fixture-repo',
          path,
          branch: 'main',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubError);
      expect((caught as GitHubError).code).toBe('GITHUB_INVALID_INPUT');
    }
    expect(harness.transport.requests.length).toBe(before);
  });

  it('scrubs credential material from errors and audit events', async () => {
    const transport = new FakeGitHubTransport({ failStatus: 401 });
    const local = buildHarness({ transport });
    await local.runtime.connector.connect().catch(() => undefined);
    let caught: unknown;
    try {
      await local.runtime.executeOperation('github.repositories.list', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as GitHubError).code).toBe('GITHUB_UNAUTHORIZED');
    const serialized = JSON.stringify(local.events);
    expect(serialized).not.toContain('ghp_');
    // The credential reference is metadata-only: a pointer to where the raw
    // token lives (env var NAME), never the token VALUE, and no secret
    // material field exists on the reference.
    expect(local.runtime.connector.credential?.providerRef).toBe('env:GITHUB_DEMO_TOKEN');
    const credential = JSON.stringify(local.runtime.connector.credential ?? {});
    expect(credential).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(credential).not.toMatch(/"value"|"secret"|"token"/i);
  });

  it('retries read operations once on 429 and succeeds (bounded backoff)', async () => {
    const transport = new FakeGitHubTransport({
      state: {
        repositories: [createFakeRepository({ owner: 'veltravia-demo', name: 'fixture-repo' })],
      },
    });
    transport.triggerRateLimit(1);
    const local = buildHarness({ transport });
    await local.runtime.connector.connect();
    const startedAt = Date.now();
    const result = await local.runtime.executeOperation('github.repositories.list', {});
    expect((result.repositories as unknown[]).length).toBe(1);
    // The bounded fallback backoff keeps the retry fast.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('maps transport failures to typed error codes', async () => {
    const expected: readonly (readonly [number, string])[] = [
      [401, 'GITHUB_UNAUTHORIZED'],
      [403, 'GITHUB_FORBIDDEN'],
      [404, 'GITHUB_NOT_FOUND'],
      [409, 'GITHUB_CONFLICT'],
      [422, 'GITHUB_VALIDATION'],
      [500, 'GITHUB_SERVER_ERROR'],
    ];
    for (const [status, code] of expected) {
      const transport = new FakeGitHubTransport();
      const local = buildHarness({ transport });
      await local.runtime.connector.connect();
      // Inject the failure AFTER a successful connect so the operation - not
      // the connection gate - is what surfaces the mapped error.
      transport.setFailure(status);
      let caught: unknown;
      try {
        await local.runtime.executeOperation('github.repositories.list', {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubError);
      expect((caught as GitHubError).code).toBe(code);
    }
  });

  it('reports honest health: no scoped repositories = unhealthy', async () => {
    const transport = new FakeGitHubTransport();
    const local = buildHarness({ scope: { repositories: [] }, transport });
    await local.runtime.connector.connect().catch(() => undefined);
    const health = await local.runtime.connector.checkHealth();
    expect(health.healthy).toBe(false);
    expect(typeof health.checkedAt).toBe('string');
    expect(health.detail).toMatch(/no scoped repositories/i);
  });
});

describe('GitHub tools through the REAL Tool System', () => {
  interface ToolHarness {
    readonly transport: FakeGitHubTransport;
    readonly tools: ToolManager;
    readonly connectors: ConnectorManager;
  }

  function buildToolHarness(options: { connect?: boolean } = {}): ToolHarness {
    const transport = new FakeGitHubTransport({
      state: {
        repositories: [
          createFakeRepository({
            owner: 'veltravia-demo',
            name: 'fixture-repo',
            files: { 'README.md': '# Fixture repository\n' },
          }),
        ],
      },
    });
    const runtime = createGitHubConnectorRuntime({
      connectorId: GITHUB_CONNECTOR_ID,
      connectionId: 'github-connection:fixture',
      scope: scope(),
      transport,
      credentialProviderRef: 'env:GITHUB_DEMO_TOKEN',
      now: NOW,
    });
    const connectors = new ConnectorManager({ now: NOW });
    const tools = new ToolManager({
      now: NOW,
      connectors,
      connectorExecutor: createGitHubOperationExecutor({
        runtimes: new Map([[runtime.connectorId, runtime]]),
      }),
    });
    for (const definition of createGitHubToolDefinitions(GITHUB_CONNECTOR_ID)) {
      tools.register(definition);
    }
    connectors.register(runtime.connector);
    if (options.connect !== false) {
      // connect() is async; Tool System tests below await as needed.
    }
    return { transport, tools, connectors, runtime } as ToolHarness & {
      runtime: ReturnType<typeof createGitHubConnectorRuntime>;
    };
  }

  it('definitions reference their connector operation and declare permissions', () => {
    const definitions = createGitHubToolDefinitions(GITHUB_CONNECTOR_ID);
    for (const definition of definitions as readonly ToolDefinition[]) {
      expect(definition.connector).toBeDefined();
      expect(definition.connector?.connectorId).toBe(GITHUB_CONNECTOR_ID);
      expect(definition.requiredPermissions.length).toBeGreaterThan(0);
      expect(definition.inputSchema).toBeDefined();
    }
  });

  it('connector registration grants nothing: availability is permission_denied', async () => {
    const harness = buildToolHarness();
    await harness.connectors.connect(GITHUB_CONNECTOR_ID);
    const availability = harness.tools.getAvailability('github-demo.contents.get');
    expect(availability.state).toBe('permission_denied');
  });

  it('tool grants do not authorize the connector: the connector gate is separate', async () => {
    const harness = buildToolHarness();
    harness.tools.grantPermission('github-demo.contents.get', 'github.contents.read');
    await harness.connectors.connect(GITHUB_CONNECTOR_ID);
    expect(harness.tools.getAvailability('github-demo.contents.get').state).toBe('available');
    // Tool permission granted, connector permission NOT: denied.
    const result = await harness.tools.invoke(
      'github-demo.contents.get',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
      },
      { requester: 'test', correlationId: 'test-run' },
    );
    expect(result.status).toBe('denied');
  });

  it('fails closed while the connector is not connected (awaiting_configuration)', async () => {
    const harness = buildToolHarness();
    harness.tools.grantPermission('github-demo.contents.get', 'github.contents.read');
    const availability = harness.tools.getAvailability('github-demo.contents.get');
    expect(['awaiting_configuration', 'unavailable']).toContain(availability.state);
  });

  it('reads a file end-to-end once registered, connected, and granted', async () => {
    const harness = buildToolHarness();
    harness.tools.grantPermission('github-demo.contents.get', 'github.contents.read');
    harness.connectors.grantPermission(GITHUB_CONNECTOR_ID, 'github.contents.read');
    await harness.connectors.connect(GITHUB_CONNECTOR_ID);
    expect(harness.tools.getAvailability('github-demo.contents.get').state).toBe('available');
    const result = await harness.tools.invoke(
      'github-demo.contents.get',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
      },
      { requester: 'test', correlationId: 'test-run' },
    );
    expect(result.status).toBe('success');
    const output = (result as { output?: { content?: string } }).output;
    expect(output?.content).toBe('# Fixture repository\n');
  });

  it('pauses for human confirmation on high-risk deletes (forced, never auto-approved)', async () => {
    const harness = buildToolHarness();
    harness.tools.grantPermission('github-demo.contents.get', 'github.contents.read');
    harness.tools.grantPermission('github-demo.contents.delete', 'github.contents.write');
    harness.connectors.grantPermission(GITHUB_CONNECTOR_ID, 'github.contents.read');
    harness.connectors.grantPermission(GITHUB_CONNECTOR_ID, 'github.contents.write');
    await harness.connectors.connect(GITHUB_CONNECTOR_ID);
    const read = await harness.tools.invoke(
      'github-demo.contents.get',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
      },
      { requester: 'test', correlationId: 'test-run' },
    );
    const sha = ((read as { output?: { sha?: string } }).output ?? {}).sha ?? '0'.repeat(40);
    const pending = await harness.tools.invoke(
      'github-demo.contents.delete',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
        message: 'Remove readme',
        sha,
      },
      { requester: 'test', correlationId: 'test-run' },
    );
    expect(pending.status).toBe('awaiting_confirmation');
    const confirmationId = (pending as { confirmationId?: string }).confirmationId;
    expect(confirmationId).toBeDefined();
    // A human decides, then the SAME invocation resumes with the decision.
    harness.tools.confirm(confirmationId as string, 'approved');
    const resumed = await harness.tools.invoke(
      'github-demo.contents.delete',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
        message: 'Remove readme',
        sha,
      },
      {
        requester: 'test',
        correlationId: 'test-run',
        confirmationId: confirmationId as string,
      },
    );
    expect(resumed.status).toBe('success');
    // The confirmation is single-use: replaying it never performs a second
    // delete - the resumed invocation is refused, not executed.
    const replay = await harness.tools.invoke(
      'github-demo.contents.delete',
      {
        owner: 'veltravia-demo',
        repository: 'fixture-repo',
        path: 'README.md',
        branch: 'main',
        message: 'Remove readme',
        sha,
      },
      {
        requester: 'test',
        correlationId: 'test-run',
        confirmationId: confirmationId as string,
      },
    );
    expect(replay.status).not.toBe('success');
  });

  it('invoking an unregistered tool id fails closed (denied, never invented)', async () => {
    const harness = buildToolHarness();
    const result = await harness.tools.invoke(
      'github-demo.not.a.tool',
      {},
      { requester: 'test', correlationId: 'test-run' },
    );
    expect(result.status).toBe('denied');
  });

  it('the executor fails closed for a tool with no connector wiring', async () => {
    const executor = createGitHubOperationExecutor({ runtimes: new Map() });
    await expect(
      executor.executeConnectorOperation(
        {
          id: 'github-demo.contents.get',
          connector: { connectorId: GITHUB_CONNECTOR_ID, operationId: 'github.contents.get' },
        } as never,
        {},
      ),
    ).rejects.toThrowError(/not wired/i);
  });
});

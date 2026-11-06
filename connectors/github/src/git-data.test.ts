import { describe, expect, it } from 'vitest';

import { createGitHubConnectorRuntime, githubOperationDeclarations } from './connector.js';
import { GitHubError } from './errors.js';
import { FakeGitDataTransport } from './git-data-fake.js';
import { createGitHubToolDefinitions } from './tools.js';
import { GITHUB_API_BASE_URL, createHttpsGitHubTransport } from './transport.js';

const OWNER = 'acme';
const REPO = 'app';

function setup(files: Record<string, string | Uint8Array> = { 'README.md': '# app\n' }) {
  const transport = new FakeGitDataTransport({
    repositories: [
      { owner: OWNER, name: REPO, files },
      { owner: 'acme', name: 'other', files: { 'x.txt': 'x' } },
    ],
  });
  const runtime = createGitHubConnectorRuntime({
    connectorId: 'github-demo',
    connectionId: 'c1',
    // Only acme/app is in scope. acme/other exists on the account but is not allowed.
    scope: { repositories: [{ owner: OWNER, repository: REPO, defaultBranch: 'main' }] },
    transport,
  });
  return { transport, runtime };
}

async function ready(files?: Record<string, string | Uint8Array>) {
  const s = setup(files);
  await s.runtime.connector.connect();
  return s;
}

const publish = (
  runtime: ReturnType<typeof setup>['runtime'],
  over: Record<string, unknown> = {},
) =>
  runtime.executeOperation('github.commit.publish', {
    owner: OWNER,
    repository: REPO,
    branch: 'main',
    expectedHeadSha: '',
    message: 'Sync from Veltravia',
    changes: [{ path: 'a.txt', content: 'a' }],
    ...over,
  });

describe('github.tree.get', () => {
  it('lists every file of a branch in one call, with the head it read', async () => {
    const { runtime, transport } = await ready({ 'a.txt': 'a', 'src/b.ts': 'b' });
    const tree = (await runtime.executeOperation('github.tree.get', {
      owner: OWNER,
      repository: REPO,
      branch: 'main',
    })) as { headSha: string; files: { path: string }[]; truncated: boolean };
    expect(tree.files.map((f) => f.path).sort()).toEqual(['a.txt', 'src/b.ts']);
    expect(tree.headSha).toBe(transport.head(OWNER, REPO, 'main'));
    expect(tree.truncated).toBe(false);
  });

  it('refuses a repository outside the connection scope, before any request', async () => {
    const { runtime, transport } = await ready();
    const before = transport.requests.length;
    await expect(
      runtime.executeOperation('github.tree.get', {
        owner: 'acme',
        repository: 'other',
        branch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'GITHUB_SCOPE_DENIED' });
    expect(transport.requests.length).toBe(before);
  });

  it('reports a branch that does not exist', async () => {
    const { runtime } = await ready();
    await expect(
      runtime.executeOperation('github.tree.get', {
        owner: OWNER,
        repository: REPO,
        branch: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'GITHUB_NOT_FOUND' });
  });
});

describe('github.blob.get', () => {
  it('returns text for a text blob and null for a binary one', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const { runtime } = await ready({ 'a.txt': 'héllo\n', 'logo.png': png });
    const tree = (await runtime.executeOperation('github.tree.get', {
      owner: OWNER,
      repository: REPO,
      branch: 'main',
    })) as { files: { path: string; sha: string }[] };
    const sha = (p: string) => tree.files.find((f) => f.path === p)?.sha as string;
    const text = await runtime.executeOperation('github.blob.get', {
      owner: OWNER,
      repository: REPO,
      sha: sha('a.txt'),
    });
    const binary = await runtime.executeOperation('github.blob.get', {
      owner: OWNER,
      repository: REPO,
      sha: sha('logo.png'),
    });
    expect(text).toMatchObject({ text: 'héllo\n' });
    expect(binary).toMatchObject({ text: null });
  });

  it('rejects a malformed sha before any request', async () => {
    const { runtime } = await ready();
    await expect(
      runtime.executeOperation('github.blob.get', {
        owner: OWNER,
        repository: REPO,
        sha: '../../etc/passwd',
      }),
    ).rejects.toThrow();
  });
});

describe('github.commit.publish', () => {
  async function head(runtime: ReturnType<typeof setup>['runtime']) {
    const tree = (await runtime.executeOperation('github.tree.get', {
      owner: OWNER,
      repository: REPO,
      branch: 'main',
    })) as { headSha: string };
    return tree.headSha;
  }

  it('lands add, modify and delete as ONE commit whose parent is the old head', async () => {
    const { runtime, transport } = await ready({
      'keep.txt': 'k',
      'edit.txt': 'old',
      'gone.txt': 'g',
    });
    const before = await head(runtime);
    const commitsBefore = transport.commitCount(OWNER, REPO);
    const result = (await publish(runtime, {
      expectedHeadSha: before,
      changes: [
        { path: 'new.txt', content: 'n' },
        { path: 'edit.txt', content: 'new' },
        { path: 'gone.txt', content: null },
      ],
    })) as { commit: { sha: string; files: number; parentSha: string } };

    expect(transport.commitCount(OWNER, REPO)).toBe(commitsBefore + 1);
    expect(result.commit.files).toBe(3);
    expect(result.commit.parentSha).toBe(before);
    expect(transport.parentsOf(OWNER, REPO, result.commit.sha)).toEqual([before]);
    expect(transport.head(OWNER, REPO, 'main')).toBe(result.commit.sha);
    expect(transport.filesAt(OWNER, REPO, 'main')).toEqual({
      'keep.txt': 'k',
      'edit.txt': 'new',
      'new.txt': 'n',
    });
    expect(transport.commitMessage(OWNER, REPO, result.commit.sha)).toBe('Sync from Veltravia');
  });

  it('writes nothing when the branch moved since it was read', async () => {
    const { runtime, transport } = await ready();
    const stale = await head(runtime);
    transport.pushDirect(OWNER, REPO, 'main', { 'theirs.txt': 't' });
    const headAfterPush = transport.head(OWNER, REPO, 'main');
    const objectsRequests = transport.requests.length;
    await expect(publish(runtime, { expectedHeadSha: stale })).rejects.toMatchObject({
      code: 'GITHUB_CONFLICT',
    });
    expect(transport.head(OWNER, REPO, 'main')).toBe(headAfterPush);
    expect(transport.filesAt(OWNER, REPO, 'main')).not.toHaveProperty('a.txt');
    // It stopped at the head check: no blob, tree or commit was even created.
    const posts = transport.requests.slice(objectsRequests).filter((r) => r.method !== 'GET');
    expect(posts).toEqual([]);
  });

  it('refuses to overwrite a push that lands between the check and the ref update', async () => {
    const { runtime, transport } = await ready();
    const stale = await head(runtime);
    transport.beforeRefUpdate = () => {
      transport.beforeRefUpdate = null;
      transport.pushDirect(OWNER, REPO, 'main', { 'theirs.txt': 't' });
    };
    await expect(publish(runtime, { expectedHeadSha: stale })).rejects.toMatchObject({
      code: 'GITHUB_VALIDATION',
    });
    // Their push survived and ours did not land.
    expect(transport.filesAt(OWNER, REPO, 'main')).toHaveProperty('theirs.txt');
    expect(transport.filesAt(OWNER, REPO, 'main')).not.toHaveProperty('a.txt');
  });

  it('never sends force: true, and never uses a generic or unknown endpoint', async () => {
    const { runtime, transport } = await ready();
    await publish(runtime, { expectedHeadSha: await head(runtime) });
    const patches = transport.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({ force: false });
    const allowed =
      /^\/(user\/repos|repos\/acme\/app(\/(branches(\/main)?|git\/(commits|trees|blobs|refs\/heads)\/?.*))?)$/;
    for (const r of transport.requests) expect(r.path).toMatch(allowed);
  });

  it('leaves the branch untouched when creating an object fails midway', async () => {
    const { runtime, transport } = await ready();
    const before = await head(runtime);
    // Fail the tree creation (after the blob), the third write.
    const readsSoFar = transport.requests.length;
    transport.failNthRequest(5, 500);
    await expect(
      publish(runtime, {
        expectedHeadSha: before,
        changes: [
          { path: 'a.txt', content: 'a' },
          { path: 'b.txt', content: 'b' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GITHUB_SERVER_ERROR' });
    expect(readsSoFar).toBeGreaterThan(0);
    expect(transport.head(OWNER, REPO, 'main')).toBe(before);
    expect(transport.filesAt(OWNER, REPO, 'main')).toEqual({ 'README.md': '# app\n' });
  });

  it('refuses a repository outside scope and writes nothing', async () => {
    const { runtime, transport } = await ready();
    const before = transport.requests.length;
    await expect(
      publish(runtime, { repository: 'other', expectedHeadSha: 'a'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'GITHUB_SCOPE_DENIED' });
    expect(transport.requests.length).toBe(before);
    expect(transport.filesAt('acme', 'other', 'main')).toEqual({ 'x.txt': 'x' });
  });

  it.each([['..'], ['../etc/passwd'], ['/abs'], ['a//b'], ['a\\b'], ['dir/'], ['']])(
    'rejects the path %j before writing anything',
    async (path) => {
      const { runtime, transport } = await ready();
      const sha = await head(runtime);
      const writes = () => transport.requests.filter((r) => r.method !== 'GET').length;
      const before = writes();
      await expect(
        publish(runtime, { expectedHeadSha: sha, changes: [{ path, content: 'x' }] }),
      ).rejects.toThrow();
      expect(writes()).toBe(before);
    },
  );

  it('rejects a duplicate path, an empty change list and malformed changes', async () => {
    const { runtime } = await ready();
    const sha = await head(runtime);
    await expect(
      publish(runtime, {
        expectedHeadSha: sha,
        changes: [
          { path: 'a', content: '1' },
          { path: 'a', content: '2' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GITHUB_INVALID_INPUT' });
    await expect(publish(runtime, { expectedHeadSha: sha, changes: [] })).rejects.toMatchObject({
      code: 'GITHUB_INVALID_INPUT',
    });
    await expect(
      publish(runtime, { expectedHeadSha: sha, changes: [{ path: 'a', content: 5 }] }),
    ).rejects.toMatchObject({ code: 'GITHUB_INVALID_INPUT' });
    await expect(publish(runtime, { expectedHeadSha: sha, changes: 'nope' })).rejects.toMatchObject(
      { code: 'GITHUB_INVALID_INPUT' },
    );
  });

  it('refuses before connect(), like every other operation', async () => {
    const { runtime } = setup();
    await expect(publish(runtime)).rejects.toMatchObject({ code: 'GITHUB_UNAUTHORIZED' });
  });
});

describe('what the assistant can reach', () => {
  it('has no tool for tree, blob or publish: the new operations are operator-only', () => {
    const ids = createGitHubToolDefinitions('github-demo').map((d) => d.connector?.operationId);
    for (const operation of ['github.tree.get', 'github.blob.get', 'github.commit.publish']) {
      expect(ids).not.toContain(operation);
    }
  });

  it('keeps multi-file publishing behind its own permission', () => {
    const publishOp = githubOperationDeclarations().find((o) => o.id === 'github.commit.publish');
    expect(publishOp?.requiredPermissions).toEqual(['github.commits.write']);
    expect(publishOp?.requiresConfirmation).toBe(true);
    const tools = createGitHubToolDefinitions('github-demo');
    for (const tool of tools) {
      expect(tool.requiredPermissions).not.toContain('github.commits.write');
    }
  });

  it('declares no repository creation or deletion operation at all', () => {
    const ids = githubOperationDeclarations().map((o) => o.id);
    expect(ids.some((id) => /repositories\.(create|delete)|repo.*delete/.test(id))).toBe(false);
  });
});

describe('the real HTTPS transport', () => {
  it('sends PATCH only to the fixed host and never follows a redirect', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = createHttpsGitHubTransport({
      getToken: async () => 'tok',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await transport.request({
      method: 'PATCH',
      path: '/repos/acme/app/git/refs/heads/main',
      body: { sha: 'a'.repeat(40), force: false },
    });
    expect(calls[0]?.url.startsWith(`${GITHUB_API_BASE_URL}/repos/acme/app/`)).toBe(true);
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.init.redirect).toBe('error');
    await expect(
      transport.request({ method: 'PATCH', path: 'https://evil.example/x' }),
    ).rejects.toThrow();
  });
});

describe('errors', () => {
  it('are GitHubError with a code, and never carry the token', async () => {
    const { runtime } = await ready();
    const error = await publish(runtime, { expectedHeadSha: 'b'.repeat(40) }).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(JSON.stringify(error)).not.toMatch(/tok|Bearer|ghp_/);
  });
});

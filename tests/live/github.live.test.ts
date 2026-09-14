import { describe, expect, it } from 'vitest';
import {
  createGitHubConnectorRuntime,
  createHttpsGitHubTransport,
  GITHUB_CONNECTOR_ID,
} from '@veltravia/connector-github';

/**
 * OPTIONAL LIVE GITHUB INTEGRATION TEST - NOT part of normal CI.
 *
 * Never runs unless ALL are present:
 *   RUN_GITHUB_INTEGRATION_TESTS=true
 *   GITHUB_API_TOKEN=<a real token (classic PAT with repo read scope)>
 *   GITHUB_TEST_REPOSITORIES=<owner/repo@branch,owner2/repo2> (READ scope only)
 *
 * Run locally:
 *   RUN_GITHUB_INTEGRATION_TESTS=true GITHUB_API_TOKEN=... \
 *     GITHUB_TEST_REPOSITORIES=octocat/Hello-World@master \
 *     npx vitest run tests/live/github.live.test.ts
 *
 * CI never sets these variables, so this file always skips there. The token
 * is read from the environment only; it is never printed, logged, or
 * committed. These tests are strictly READ-ONLY: they never create, update,
 * or delete anything in the remote repositories.
 */

const enabled =
  process.env.RUN_GITHUB_INTEGRATION_TESTS === 'true' &&
  typeof process.env.GITHUB_API_TOKEN === 'string' &&
  process.env.GITHUB_API_TOKEN.length > 0 &&
  typeof process.env.GITHUB_TEST_REPOSITORIES === 'string' &&
  process.env.GITHUB_TEST_REPOSITORIES.length > 0;

describe.skipIf(!enabled)('live GitHub connector (read-only)', () => {
  const build = () => {
    const token = process.env.GITHUB_API_TOKEN as string;
    const raw = process.env.GITHUB_TEST_REPOSITORIES as string;
    const repositories = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [ownerRepo, branch] = entry.split('@');
        const [owner, repository] = (ownerRepo ?? '').split('/');
        if (!owner || !repository) {
          throw new Error(`invalid GITHUB_TEST_REPOSITORIES entry: ${entry}`);
        }
        return { owner, repository, defaultBranch: branch || 'master' };
      });
    const runtime = createGitHubConnectorRuntime({
      connectorId: GITHUB_CONNECTOR_ID,
      connectionId: 'github-connection:live-test',
      scope: { repositories },
      transport: createHttpsGitHubTransport({ getToken: async () => token }),
      credentialProviderRef: 'env:GITHUB_API_TOKEN',
    });
    return { runtime, repositories };
  };

  it('connects and lists only the scoped repositories', async () => {
    const { runtime } = build();
    await runtime.connector.connect();
    const result = await runtime.executeOperation('github.repositories.list', {});
    const repositories = result.repositories as { owner: string; repository: string }[];
    expect(repositories.length).toBeGreaterThan(0);
    for (const repository of repositories) {
      expect(repository.owner.length).toBeGreaterThan(0);
      expect(repository.repository.length).toBeGreaterThan(0);
    }
  });

  it('lists branches and reads the root listing from the first repository', async () => {
    const { runtime, repositories: scope } = build();
    await runtime.connector.connect();
    const first = scope[0] as { owner: string; repository: string; defaultBranch: string };
    const branches = await runtime.executeOperation('github.branches.list', {
      owner: first.owner,
      repository: first.repository,
    });
    const branchNames = (branches.branches as { name: string }[]).map((branch) => branch.name);
    expect(branchNames.length).toBeGreaterThan(0);
    expect(branchNames).toContain(first.defaultBranch);

    // Root listing of the default branch: proves scoped contents access
    // without mutating anything.
    const contents = await runtime.executeOperation('github.contents.list', {
      owner: first.owner,
      repository: first.repository,
      path: '.',
      branch: first.defaultBranch,
    });
    expect(Array.isArray(contents.entries)).toBe(true);
  });

  it('rejects out-of-scope repositories', async () => {
    const { runtime } = build();
    await runtime.connector.connect();
    await expect(
      runtime.executeOperation('github.contents.get', {
        owner: 'veltravia-out-of-scope-owner',
        repository: 'does-not-matter',
        path: '.',
        branch: 'main',
      }),
    ).rejects.toThrow();
  });
});

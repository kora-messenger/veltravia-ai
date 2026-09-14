import type { ConnectorManager } from '@veltravia/connector-core';
import type { ToolManager } from '@veltravia/tool-core';
import {
  FakeGitHubTransport,
  createFakeRepository,
  createGitHubConnectorRuntime,
  createGitHubToolDefinitions,
  createHttpsGitHubTransport,
  GITHUB_CONNECTOR_ID,
  type GitHubConnectorRuntime,
  type GitHubConnectionScope,
} from '@veltravia/connector-github';

/**
 * API wiring for the GitHub connector (Step 10).
 *
 * Two modes, decided ONLY by environment:
 *
 * - REAL mode: GITHUB_API_TOKEN + GITHUB_REPOSITORIES are set. The connector
 *   talks to api.github.com through the production HTTPS transport, scoped to
 *   exactly the listed repositories - never all of them. The token is read
 *   through a provider callback and is never retained or logged.
 *
 * - DEMO mode (default): no env vars. The connector runs against the offline
 *   deterministic fake transport, same as the demo coding decision source.
 *   This is a DOCUMENTED development-only limitation: the orchestration,
 *   scope enforcement, path safety, revision protection, and confirmation
 *   gates are fully real; only the remote end is a fixture.
 *
 * Registration grants nothing: this wiring acts as the operator, so it grants
 * the GitHub tool permissions explicitly, server-side, and connects through
 * the real ConnectorManager lifecycle.
 */

/** Parses "owner/repo@branch,owner2/repo2" into a validated connection scope. */
export function parseGitHubScope(raw: string): GitHubConnectionScope['repositories'] {
  const repositories: GitHubConnectionScope['repositories'][number][] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [ownerRepo, branch] = trimmed.split('@');
    const [owner, repository] = (ownerRepo ?? '').split('/');
    if (
      typeof owner !== 'string' ||
      owner.length === 0 ||
      typeof repository !== 'string' ||
      repository.length === 0
    ) {
      throw new Error(
        'GITHUB_REPOSITORIES must be a comma list of owner/repository[@branch] entries',
      );
    }
    repositories.push({ owner, repository, defaultBranch: branch?.trim() || 'main' });
  }
  if (repositories.length === 0) {
    throw new Error('GITHUB_REPOSITORIES parsed to an empty scope');
  }
  return repositories;
}

export interface GitHubApiConnectorOptions {
  readonly now?: () => Date;
}

export interface GitHubApiConnector {
  readonly runtime: GitHubConnectorRuntime;
  readonly isDemo: boolean;
  /** Registers the connector's tools into a ToolManager and grants permissions. */
  readonly registerTools: (tools: ToolManager) => readonly string[];
  /** Registers the connector into a ConnectorManager and connects it. */
  readonly registerAndConnect: (connectors: ConnectorManager) => Promise<void>;
}

export function createGitHubApiConnector(
  options: GitHubApiConnectorOptions = {},
): GitHubApiConnector {
  const now = options.now ?? (() => new Date());
  const token = process.env['GITHUB_API_TOKEN'];
  const scopeRaw = process.env['GITHUB_REPOSITORIES'];
  const real =
    token !== undefined && token.length > 0 && scopeRaw !== undefined && scopeRaw.length > 0;

  const runtime = real
    ? createGitHubConnectorRuntime({
        connectorId: GITHUB_CONNECTOR_ID,
        connectionId: 'github-connection:api',
        scope: { repositories: parseGitHubScope(scopeRaw as string) },
        transport: createHttpsGitHubTransport({
          // The token is read through a provider callback; the runtime never
          // stores it and errors are scrubbed of credential material.
          getToken: async () => token as string,
        }),
        credentialProviderRef: 'env:GITHUB_API_TOKEN',
        now,
      })
    : createGitHubConnectorRuntime({
        connectorId: GITHUB_CONNECTOR_ID,
        connectionId: 'github-connection:api-demo',
        scope: {
          repositories: [
            { owner: 'veltravia-demo', repository: 'fixture-repo', defaultBranch: 'main' },
          ],
        },
        transport: new FakeGitHubTransport({
          state: {
            repositories: [
              createFakeRepository({
                owner: 'veltravia-demo',
                name: 'fixture-repo',
                description: 'offline fixture repository (demo mode)',
                files: {
                  'README.md':
                    '# Veltravia demo fixture\n\nOffline content for the demo GitHub connector.\n',
                },
              }),
            ],
          },
        }),
        now,
      });

  return {
    runtime,
    isDemo: !real,
    registerTools(tools: ToolManager): readonly string[] {
      const definitions = createGitHubToolDefinitions(GITHUB_CONNECTOR_ID);
      for (const definition of definitions) {
        tools.register(definition);
      }
      // Explicit server-side grants - the operator role, not the agent's.
      for (const definition of definitions) {
        for (const permission of definition.requiredPermissions) {
          tools.grantPermission(definition.id, permission);
        }
      }
      return definitions.map((definition) => definition.id);
    },
    async registerAndConnect(connectors: ConnectorManager): Promise<void> {
      connectors.register(runtime.connector);
      // The connector permission gate is separate from the tool gate: grant
      // each declared permission explicitly, then connect through the real
      // lifecycle (connect proves the connection once; grants stay ours).
      for (const permission of runtime.connector.permissions) {
        connectors.grantPermission(GITHUB_CONNECTOR_ID, permission.id);
      }
      await connectors.connect(GITHUB_CONNECTOR_ID);
    },
  };
}

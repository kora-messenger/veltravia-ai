/** GitHub provider. Live-capable, read-only, and only through an injected
 *  transport: the provider itself never opens a socket, so CI stays offline
 *  and every call is inspectable. HTTPS to api.github.com is enforced by the
 *  SSRF guard, repository access is restricted to a configured allowlist, and
 *  no write endpoint exists in this file. */
import { ConnectedAppError } from '../errors/index.js';
import { assertSafeRemoteUrl, bounded } from '../security/index.js';
import type { ProviderHealth, ConnectedAppProvider } from '../provider/index.js';
import type {
  ConnectedAccount,
  ConnectedResource,
  ProviderAuthResult,
  ProviderDescriptor,
  RateLimitInfo,
  ResourceContent,
  ResourcePage,
} from '../types/index.js';

export interface HttpJsonRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface HttpJsonResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded JSON body, or the raw text when the response is not JSON. */
  readonly body: unknown;
}

/** Anything that can perform an HTTPS GET. Injected so tests never go online. */
export interface HttpJsonTransport {
  get(request: HttpJsonRequest): Promise<HttpJsonResponse>;
}

export interface GitHubProviderOptions {
  /** Lowercase "owner/repository" entries this connection may read. */
  readonly allowedRepositories: readonly string[];
  /** Test seam: the transport used for every request. */
  readonly transport: HttpJsonTransport;
}

const DESCRIPTOR: ProviderDescriptor = {
  id: 'github',
  name: 'GitHub',
  description: 'Read repositories, files, issues, pull requests and commits you can access.',
  liveCapable: true,
  capabilities: [
    'list_resources',
    'search_resources',
    'resource_metadata',
    'resource_content',
    'repository_tree',
    'repository_search',
  ],
  scopes: [
    { id: 'repositories:read', description: 'List repositories you can access.', risk: 'low' },
    { id: 'contents:read', description: 'Read repository files and metadata.', risk: 'low' },
    { id: 'issues:read', description: 'Read issues and pull requests.', risk: 'low' },
    { id: 'commits:read', description: 'Read commit history.', risk: 'low' },
  ],
  capabilityScopes: {
    list_resources: 'repositories:read',
    search_resources: 'contents:read',
    resource_metadata: 'contents:read',
    resource_content: 'contents:read',
    repository_tree: 'contents:read',
    repository_search: 'contents:read',
  },
};

const API_HOST = 'api.github.com';
const BASE = `https://${API_HOST}`;

export class GitHubProvider implements ConnectedAppProvider {
  readonly descriptor = DESCRIPTOR;
  readonly #allowed: readonly string[];
  readonly #transport: HttpJsonTransport;

  constructor(options: GitHubProviderOptions) {
    this.#allowed = options.allowedRepositories.map((entry) => entry.toLowerCase());
    this.#transport = options.transport;
  }

  async authenticate(input: {
    readonly grantedScopes: readonly string[];
    readonly credential: string | null;
  }): Promise<ProviderAuthResult> {
    if (!input.credential)
      throw new ConnectedAppError(
        'CONNECTED_INVALID_REQUEST',
        'GitHub needs a personal access token before it can connect.',
      );
    const response = await this.#request('/user', input.credential);
    const body = response.body as { login?: unknown; name?: unknown; email?: unknown };
    if (response.status === 401 || response.status === 403)
      throw new ConnectedAppError('CONNECTED_REVOKED', 'GitHub rejected that authorization.');
    if (response.status !== 200)
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNAVAILABLE', 'GitHub is unavailable.');
    return {
      status: 'connected',
      account: {
        accountId: bounded(String(body.login ?? 'github-user'), 200),
        displayName: bounded(String(body.name ?? body.login ?? 'GitHub account'), 200),
        email: typeof body.email === 'string' ? bounded(body.email, 320) : null,
      },
      credentialRef: `github:${bounded(String(body.login ?? 'user'), 80)}`,
    };
  }

  async revoke(): Promise<void> {
    // Personal access tokens are revoked by the user at GitHub. We only drop
    // our stored reference, so there is nothing to call here.
  }

  async health(input: {
    readonly connection: ConnectedAccount;
    readonly credential: string | null;
  }): Promise<ProviderHealth> {
    if (!input.credential)
      return { healthy: false, status: 'expired', detail: 'No stored token.', rateLimit: null };
    const response = await this.#request('/user', input.credential);
    return {
      healthy: response.status === 200,
      status: response.status === 200 ? 'connected' : 'expired',
      detail:
        response.status === 200
          ? 'GitHub accepted the stored token.'
          : `GitHub returned status ${response.status}.`,
      rateLimit: rateLimitOf(response.headers),
    };
  }

  async listResources(input: {
    readonly credential: string | null;
    readonly cursor: string | null;
    readonly maxItems: number;
  }): Promise<ResourcePage> {
    const token = this.#token(input.credential);
    const page = pageOf(input.cursor);
    const response = await this.#request(
      `/user/repos?per_page=${input.maxItems}&page=${page}`,
      token,
    );
    if (response.status !== 200)
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNAVAILABLE', 'GitHub is unavailable.');
    const repos = Array.isArray(response.body) ? (response.body as GitHubRepo[]) : [];
    const visible = repos.filter((repo) => this.#permitted(`${repo.owner?.login}/${repo.name}`));
    const resources = visible
      .slice(0, input.maxItems)
      .map((repo) => this.#repositoryResource(repo));
    return {
      resources,
      nextCursor: repos.length === input.maxItems ? String(page + 1) : null,
      truncated: repos.length > input.maxItems,
      rateLimit: rateLimitOf(response.headers),
    };
  }

  async searchResources(input: {
    readonly credential: string | null;
    readonly query: string;
    readonly cursor: string | null;
    readonly maxItems: number;
  }): Promise<ResourcePage> {
    const token = this.#token(input.credential);
    const page = pageOf(input.cursor);
    const scope =
      this.#allowed.length > 0 ? `${this.#allowed.map((r) => `repo:${r}`).join(' ')} ` : '';
    const url = `/search/code?per_page=${input.maxItems}&page=${page}&q=${encodeURIComponent(`${scope}${input.query.trim()}`)}`;
    const response = await this.#request(url, token);
    if (response.status === 403 || response.status === 429)
      throw new ConnectedAppError('CONNECTED_RATE_LIMITED', 'GitHub rate limit reached.');
    if (response.status !== 200)
      throw new ConnectedAppError(
        'CONNECTED_PROVIDER_UNAVAILABLE',
        'GitHub search is unavailable.',
      );
    const body = response.body as { items?: GitHubCodeItem[]; total_count?: number };
    const items = Array.isArray(body.items) ? body.items : [];
    const resources = items
      .filter((item) => this.#permitted(item.repository?.full_name ?? ''))
      .map((item) => ({
        providerId: 'github' as const,
        resourceId: `file:${item.repository.full_name}:${item.path}`,
        kind: 'file' as const,
        name: item.name,
        path: item.path,
        mimeType: null,
        byteSize: null,
        modifiedAt: null,
        revision: item.sha ?? null,
        url: item.html_url ?? null,
        provenance: {
          providerId: 'github' as const,
          providerName: 'GitHub',
          accountId: '',
          connectionId: '',
          resourceId: `file:${item.repository.full_name}:${item.path}`,
          resourceName: item.name,
          sourceUrl: item.html_url ?? null,
          retrievedAt: new Date(0).toISOString(),
          revision: item.sha ?? null,
        },
      }));
    return {
      resources,
      nextCursor: items.length === input.maxItems ? String(page + 1) : null,
      truncated: (body.total_count ?? 0) > input.maxItems,
      rateLimit: rateLimitOf(response.headers),
    };
  }

  async getResource(input: {
    readonly credential: string | null;
    readonly resourceId: string;
  }): Promise<ConnectedResource> {
    const token = this.#token(input.credential);
    const parsed = parseResourceId(input.resourceId);
    if (parsed.kind === 'repository') {
      const response = await this.#request(`/repos/${parsed.repository}`, token);
      if (response.status === 404)
        throw new ConnectedAppError(
          'CONNECTED_RESOURCE_NOT_FOUND',
          'That repository was not found.',
        );
      if (response.status !== 200)
        throw new ConnectedAppError('CONNECTED_PROVIDER_UNAVAILABLE', 'GitHub is unavailable.');
      return this.#repositoryResource(response.body as GitHubRepo);
    }
    const response = await this.#request(
      `/repos/${parsed.repository}/contents/${encodeURIComponent(parsed.path)}`,
      token,
    );
    if (response.status === 404)
      throw new ConnectedAppError('CONNECTED_RESOURCE_NOT_FOUND', 'That file was not found.');
    if (response.status !== 200)
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNAVAILABLE', 'GitHub is unavailable.');
    const body = response.body as GitHubContent;
    return {
      providerId: 'github',
      resourceId: input.resourceId,
      kind: 'file',
      name: body.name ?? parsed.path,
      path: body.path ?? parsed.path,
      mimeType: null,
      byteSize: typeof body.size === 'number' ? body.size : null,
      modifiedAt: null,
      revision: body.sha ?? null,
      url: body.html_url ?? null,
      provenance: EMPTY_PROVENANCE(
        input.resourceId,
        body.name ?? parsed.path,
        body.html_url ?? null,
        body.sha ?? null,
      ),
    };
  }

  async getContent(input: {
    readonly credential: string | null;
    readonly resourceId: string;
    readonly maxBytes: number;
  }): Promise<ResourceContent> {
    const token = this.#token(input.credential);
    const parsed = parseResourceId(input.resourceId);
    if (parsed.kind !== 'file')
      throw new ConnectedAppError(
        'CONNECTED_CONTENT_UNSUPPORTED',
        'Only repository files have readable content.',
      );
    const response = await this.#request(
      `/repos/${parsed.repository}/contents/${encodeURIComponent(parsed.path)}`,
      token,
      'application/vnd.github.raw',
    );
    if (response.status === 404)
      throw new ConnectedAppError('CONNECTED_RESOURCE_NOT_FOUND', 'That file was not found.');
    if (response.status !== 200)
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNAVAILABLE', 'GitHub is unavailable.');
    const raw = typeof response.body === 'string' ? response.body : '';
    const bytes = new TextEncoder().encode(raw);
    if (bytes.byteLength > input.maxBytes)
      throw new ConnectedAppError(
        'CONNECTED_LIMIT_EXCEEDED',
        'That file is larger than the limit.',
      );
    return {
      resource: {
        providerId: 'github',
        resourceId: input.resourceId,
        kind: 'file',
        name: parsed.path,
        path: parsed.path,
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
        modifiedAt: null,
        revision: null,
        url: null,
        provenance: EMPTY_PROVENANCE(input.resourceId, parsed.path, null, null),
      },
      bytes,
      mimeType: 'text/plain',
      encoding: 'text',
      provenance: EMPTY_PROVENANCE(input.resourceId, parsed.path, null, null),
      fromCache: false,
      ageSeconds: 0,
    };
  }

  #token(credential: string | null): string {
    if (!credential)
      throw new ConnectedAppError(
        'CONNECTED_EXPIRED',
        'This GitHub connection has no stored token. Reconnect it.',
      );
    return credential;
  }

  #permitted(fullName: string): boolean {
    if (this.#allowed.length === 0) return false;
    return this.#allowed.includes(fullName.toLowerCase());
  }

  #repositoryResource(repo: GitHubRepo): ConnectedResource {
    const fullName = `${repo.owner?.login}/${repo.name}`;
    const resourceId = `repo:${fullName}`;
    return {
      providerId: 'github',
      resourceId,
      kind: 'repository',
      name: repo.name,
      path: fullName,
      mimeType: null,
      byteSize: typeof repo.size === 'number' ? repo.size * 1024 : null,
      modifiedAt: repo.updated_at ?? null,
      revision: repo.default_branch ?? null,
      url: repo.html_url ?? null,
      provenance: EMPTY_PROVENANCE(
        resourceId,
        repo.name,
        repo.html_url ?? null,
        repo.default_branch ?? null,
      ),
    };
  }

  async #request(
    path: string,
    token: string,
    accept = 'application/vnd.github+json',
  ): Promise<HttpJsonResponse> {
    const url = assertSafeRemoteUrl(`${BASE}${path}`, [API_HOST]).toString();
    const response = await this.#transport.get({
      url,
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        'user-agent': 'veltravia-ai',
        'x-github-api-version': '2022-11-28',
      },
      signal: new AbortController().signal,
    });
    return response;
  }
}

function EMPTY_PROVENANCE(
  resourceId: string,
  name: string,
  url: string | null,
  revision: string | null,
) {
  return {
    providerId: 'github' as const,
    providerName: 'GitHub',
    accountId: '',
    connectionId: '',
    resourceId,
    resourceName: name,
    sourceUrl: url,
    retrievedAt: new Date(0).toISOString(),
    revision,
  };
}

function pageOf(cursor: string | null): number {
  if (!cursor) return 1;
  const page = Number.parseInt(cursor, 10);
  return Number.isFinite(page) && page > 0 && page < 1000 ? page : 1;
}

function rateLimitOf(headers: Readonly<Record<string, string>>): RateLimitInfo {
  const remaining = headers['x-ratelimit-remaining'];
  const limit = headers['x-ratelimit-limit'];
  const reset = headers['x-ratelimit-reset'];
  return {
    remaining: remaining ? Number(remaining) : null,
    limit: limit ? Number(limit) : null,
    resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
  };
}

function parseResourceId(
  resourceId: string,
): { kind: 'repository'; repository: string } | { kind: 'file'; repository: string; path: string } {
  if (resourceId.startsWith('repo:')) {
    const repository = resourceId.slice(5).toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'That repository id is invalid.');
    return { kind: 'repository', repository };
  }
  if (resourceId.startsWith('file:')) {
    const rest = resourceId.slice(5);
    const split = rest.indexOf(':');
    if (split < 0)
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'That file id is invalid.');
    const repository = rest.slice(0, split).toLowerCase();
    const path = rest.slice(split + 1);
    if (
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ||
      path.length === 0 ||
      path.includes('..')
    )
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'That file id is invalid.');
    return { kind: 'file', repository, path };
  }
  throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'Unknown GitHub resource id.');
}

interface GitHubRepo {
  readonly name: string;
  readonly owner?: { readonly login?: string };
  readonly size?: number;
  readonly updated_at?: string;
  readonly default_branch?: string;
  readonly html_url?: string;
}
interface GitHubCodeItem {
  readonly name: string;
  readonly path: string;
  readonly sha?: string;
  readonly html_url?: string;
  readonly repository: { readonly full_name: string };
}
interface GitHubContent {
  readonly name?: string;
  readonly path?: string;
  readonly sha?: string;
  readonly size?: number;
  readonly html_url?: string;
}

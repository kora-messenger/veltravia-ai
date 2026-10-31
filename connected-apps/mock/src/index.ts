/** Deterministic, keyless mock connected-app providers. They exist so the
 *  whole pipeline - connection lifecycle, paging, search, content, document
 *  parsing, provenance, agent tools - can be tested offline and in CI.
 *
 *  They are NOT live providers: every fixture is fixed, `liveCapable` is false,
 *  and the UI says so. Fault injection is explicit and opt-in so tests can
 *  prove that rate limits, timeouts and revoked connections surface honestly.
 */
import {
  ConnectedAppError,
  type ConnectedAppProvider,
  type ConnectedResource,
  type ProviderAuthResult,
  type ProviderDescriptor,
  type ProviderHealth,
  type ResourceContent,
  type ResourcePage,
} from '@veltravia/connected-apps-core';

export interface MockFaults {
  /** Fail every operation with a rate-limit error after N successful calls. */
  readonly rateLimitAfter?: number;
  /** Throw a transport-style failure (used to prove timeout normalization). */
  readonly hang?: boolean;
  /** Report the connection as revoked on authenticate. */
  readonly revokeOnConnect?: boolean;
  /** Resource ids the provider will refuse, simulating provider permissions. */
  readonly forbiddenResourceIds?: readonly string[];
}

export interface MockProviderOptions {
  readonly faults?: MockFaults;
  readonly now?: () => Date;
}

interface MockEntry {
  readonly resourceId: string;
  readonly kind: ConnectedResource['kind'];
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly revision: string;
  readonly modifiedAt: string;
  readonly url: string | null;
  readonly text: string | null;
  readonly tags: readonly string[];
}

const STAMP = '2026-09-01T09:00:00.000Z';

const GITHUB_ENTRIES: readonly MockEntry[] = [
  {
    resourceId: 'repo:acme/messenger',
    kind: 'repository',
    name: 'messenger',
    path: 'acme/messenger',
    mimeType: 'application/vnd.github+json',
    revision: 'main',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger',
    text: null,
    tags: ['repository', 'authentication', 'messaging'],
  },
  {
    resourceId: 'file:acme/messenger:docs/architecture.md',
    kind: 'file',
    name: 'architecture.md',
    path: 'docs/architecture.md',
    mimeType: 'text/markdown',
    revision: 'sha-arch-1',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger/blob/main/docs/architecture.md',
    text: [
      '# Messenger Architecture',
      '',
      'The service is a Fastify API in front of a Postgres database.',
      '',
      '## Authentication',
      '',
      'Authentication uses short-lived access tokens and rotating refresh tokens.',
      '',
      '## Messaging',
      '',
      'Messages are written to Postgres and fanned out over WebSockets.',
      '',
      '| Layer | Technology |',
      '| --- | --- |',
      '| API | Fastify |',
      '| Database | Postgres |',
      '| Transport | WebSocket |',
      '',
    ].join('\n'),
    tags: ['architecture', 'database', 'authentication'],
  },
  {
    resourceId: 'file:acme/messenger:README.md',
    kind: 'file',
    name: 'README.md',
    path: 'README.md',
    mimeType: 'text/markdown',
    revision: 'sha-readme-1',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger/blob/main/README.md',
    text: '# Acme Messenger\n\nA WhatsApp-style messenger built on Fastify.\n\n## Setup\n\nRun `npm install` then `npm test`.\n',
    tags: ['readme', 'setup'],
  },
  {
    resourceId: 'file:acme/messenger:src/auth/session.ts',
    kind: 'file',
    name: 'session.ts',
    path: 'src/auth/session.ts',
    mimeType: 'text/plain',
    revision: 'sha-session-3',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger/blob/main/src/auth/session.ts',
    text: 'export function rotateRefreshToken(token: string): string {\n  return `rotated:${token.length}`;\n}\n',
    tags: ['authentication', 'code'],
  },
  {
    resourceId: 'file:acme/messenger:package.json',
    kind: 'file',
    name: 'package.json',
    path: 'package.json',
    mimeType: 'application/json',
    revision: 'sha-pkg-2',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger/blob/main/package.json',
    text: '{\n  "name": "acme-messenger",\n  "version": "1.4.0",\n  "dependencies": { "fastify": "^5.0.0" }\n}\n',
    tags: ['manifest'],
  },
  {
    resourceId: 'issue:acme/messenger:118',
    kind: 'issue',
    name: 'Refresh token rotation drops sessions',
    path: 'issues/118',
    mimeType: 'text/markdown',
    revision: 'issue-118',
    modifiedAt: STAMP,
    url: 'https://github.com/acme/messenger/issues/118',
    text: 'Users are logged out after a token refresh when two devices are active.\n',
    tags: ['issue', 'authentication'],
  },
];

const DRIVE_ENTRIES: readonly MockEntry[] = [
  {
    resourceId: 'drive:proposal-q3.docx',
    kind: 'document',
    name: 'Q3 Project Proposal.docx',
    path: 'Proposals/Q3 Project Proposal.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    revision: 'rev-7',
    modifiedAt: STAMP,
    url: null,
    text: null,
    tags: ['proposal', 'q3'],
  },
  {
    resourceId: 'drive:roadmap.md',
    kind: 'document',
    name: 'Roadmap.md',
    path: 'Planning/Roadmap.md',
    mimeType: 'text/markdown',
    revision: 'rev-3',
    modifiedAt: STAMP,
    url: null,
    text: [
      '# Product Roadmap',
      '',
      '## Q3',
      '',
      'Ship the connected-app intelligence release.',
      '',
      '## Q4',
      '',
      'Harden authentication and add offline mode.',
      '',
    ].join('\n'),
    tags: ['roadmap', 'planning'],
  },
  {
    resourceId: 'drive:budget.csv',
    kind: 'document',
    name: 'Budget.csv',
    path: 'Finance/Budget.csv',
    mimeType: 'text/csv',
    revision: 'rev-2',
    modifiedAt: STAMP,
    url: null,
    text: 'Item,Amount\nCompute,1200\nStorage,300\n',
    tags: ['budget', 'finance'],
  },
  {
    resourceId: 'drive:architecture.json',
    kind: 'document',
    name: 'Architecture.json',
    path: 'Engineering/Architecture.json',
    mimeType: 'application/json',
    revision: 'rev-11',
    modifiedAt: STAMP,
    url: null,
    text: '{\n  "database": "postgres",\n  "transport": "websocket",\n  "auth": "jwt-rotating"\n}\n',
    tags: ['architecture', 'database'],
  },
];

const NOTION_ENTRIES: readonly MockEntry[] = [
  {
    resourceId: 'page:auth-spec',
    kind: 'page',
    name: 'Authentication Specification',
    path: 'Engineering/Authentication Specification',
    mimeType: 'text/markdown',
    revision: 'page-auth-4',
    modifiedAt: STAMP,
    url: 'https://notion.example.com/auth-spec',
    text: [
      '# Authentication Specification',
      '',
      '## Session model',
      '',
      'Access tokens expire after fifteen minutes. Refresh tokens rotate on every use.',
      '',
      '## Failure handling',
      '',
      'A reused refresh token revokes the whole session family.',
      '',
    ].join('\n'),
    tags: ['authentication', 'specification'],
  },
  {
    resourceId: 'page:onboarding',
    kind: 'page',
    name: 'Onboarding Checklist',
    path: 'People/Onboarding Checklist',
    mimeType: 'text/markdown',
    revision: 'page-onb-2',
    modifiedAt: STAMP,
    url: 'https://notion.example.com/onboarding',
    text: '# Onboarding Checklist\n\n- Create accounts\n- Read the authentication specification\n',
    tags: ['onboarding'],
  },
  {
    resourceId: 'database:engineering-tasks',
    kind: 'database',
    name: 'Engineering Tasks',
    path: 'Engineering/Tasks',
    mimeType: 'application/json',
    revision: 'db-1',
    modifiedAt: STAMP,
    url: 'https://notion.example.com/tasks',
    text: '[\n  { "title": "Token rotation", "status": "In progress" },\n  { "title": "Offline mode", "status": "Backlog" }\n]\n',
    tags: ['tasks', 'database'],
  },
];

function descriptor(
  id: 'github' | 'google_drive' | 'notion',
  name: string,
  description: string,
  scopes: readonly { id: string; description: string }[],
  capabilityScopes: ProviderDescriptor['capabilityScopes'],
): ProviderDescriptor {
  return {
    id,
    name,
    description,
    liveCapable: false,
    capabilities: ['list_resources', 'search_resources', 'resource_metadata', 'resource_content'],
    scopes: scopes.map((scope) => ({ ...scope, risk: 'low' as const })),
    capabilityScopes,
  };
}

class MockProvider implements ConnectedAppProvider {
  readonly descriptor: ProviderDescriptor;
  readonly #entries: readonly MockEntry[];
  readonly #account: { accountId: string; displayName: string; email: string };
  readonly #faults: MockFaults;
  readonly #now: () => Date;
  #calls = 0;

  constructor(
    descriptorValue: ProviderDescriptor,
    entries: readonly MockEntry[],
    account: { accountId: string; displayName: string; email: string },
    options: MockProviderOptions,
  ) {
    this.descriptor = descriptorValue;
    this.#entries = entries;
    this.#account = account;
    this.#faults = options.faults ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async authenticate(): Promise<ProviderAuthResult> {
    if (this.#faults.revokeOnConnect)
      return {
        status: 'revoked',
        account: this.#account,
        credentialRef: null,
      };
    return {
      status: 'connected',
      account: this.#account,
      credentialRef: `mock:${this.descriptor.id}`,
    };
  }

  async revoke(): Promise<void> {
    // Mock tokens live only in the manager's vault; nothing external to revoke.
  }

  async health(): Promise<ProviderHealth> {
    if (this.#faults.hang)
      return {
        healthy: false,
        status: 'connected',
        detail: 'The provider did not respond.',
        rateLimit: null,
      };
    return {
      healthy: true,
      status: 'connected',
      detail: 'Mock provider is responding.',
      rateLimit: { remaining: 100, limit: 100, resetAt: null },
    };
  }

  async listResources(input: {
    readonly cursor: string | null;
    readonly query: string | null;
    readonly maxItems: number;
  }): Promise<ResourcePage> {
    this.#guard();
    const start = cursorIndex(input.cursor);
    const matched = this.#entries.filter(
      (entry) => input.query === null || matches(entry, input.query),
    );
    return this.#page(matched, start, input.maxItems);
  }

  async searchResources(input: {
    readonly query: string;
    readonly cursor: string | null;
    readonly maxItems: number;
  }): Promise<ResourcePage> {
    this.#guard();
    const start = cursorIndex(input.cursor);
    const matched = this.#entries.filter((entry) => matches(entry, input.query));
    return this.#page(matched, start, input.maxItems);
  }

  async getResource(input: { readonly resourceId: string }): Promise<ConnectedResource> {
    this.#guard();
    const entry = this.#find(input.resourceId);
    return this.#resourceOf(entry);
  }

  async getContent(input: {
    readonly resourceId: string;
    readonly maxBytes: number;
  }): Promise<ResourceContent> {
    this.#guard();
    const entry = this.#find(input.resourceId);
    if (entry.text === null)
      throw new ConnectedAppError(
        'CONNECTED_CONTENT_UNSUPPORTED',
        'That resource has no readable content in this simulation.',
      );
    const bytes = new TextEncoder().encode(entry.text);
    if (bytes.byteLength > input.maxBytes)
      throw new ConnectedAppError('CONNECTED_LIMIT_EXCEEDED', 'That resource is too large.');
    const at = this.#now().toISOString();
    const provenance = {
      providerId: this.descriptor.id,
      providerName: this.descriptor.name,
      accountId: this.#account.accountId,
      connectionId: '',
      resourceId: entry.resourceId,
      resourceName: entry.name,
      sourceUrl: entry.url,
      retrievedAt: at,
      revision: entry.revision,
    };
    return {
      resource: this.#resourceOf(entry),
      bytes,
      mimeType: entry.mimeType,
      encoding: 'text',
      provenance,
      fromCache: false,
      ageSeconds: 0,
    };
  }

  #guard(): void {
    this.#calls += 1;
    if (this.#faults.hang) throw new Error('provider transport hung');
    const limit = this.#faults.rateLimitAfter;
    if (limit !== undefined && this.#calls > limit)
      throw new ConnectedAppError('CONNECTED_RATE_LIMITED', 'Mock rate limit reached.');
  }

  #find(resourceId: string): MockEntry {
    const entry = this.#entries.find((candidate) => candidate.resourceId === resourceId);
    if (!entry)
      throw new ConnectedAppError('CONNECTED_RESOURCE_NOT_FOUND', 'That resource was not found.');
    if (this.#faults.forbiddenResourceIds?.includes(resourceId))
      throw new ConnectedAppError(
        'CONNECTED_RESOURCE_FORBIDDEN',
        'The provider refused access to that resource.',
      );
    return entry;
  }

  #page(entries: readonly MockEntry[], start: number, maxItems: number): ResourcePage {
    const slice = entries.slice(start, start + maxItems);
    const nextIndex = start + slice.length;
    return {
      resources: slice.map((entry) => this.#resourceOf(entry)),
      nextCursor: nextIndex < entries.length ? String(nextIndex) : null,
      truncated: nextIndex < entries.length,
      rateLimit: { remaining: 100 - this.#calls, limit: 100, resetAt: null },
    };
  }

  #resourceOf(entry: MockEntry): ConnectedResource {
    return {
      providerId: this.descriptor.id,
      resourceId: entry.resourceId,
      kind: entry.kind,
      name: entry.name,
      path: entry.path,
      mimeType: entry.mimeType,
      byteSize: entry.text === null ? null : new TextEncoder().encode(entry.text).byteLength,
      modifiedAt: entry.modifiedAt,
      revision: entry.revision,
      url: entry.url,
      provenance: {
        providerId: this.descriptor.id,
        providerName: this.descriptor.name,
        accountId: this.#account.accountId,
        connectionId: '',
        resourceId: entry.resourceId,
        resourceName: entry.name,
        sourceUrl: entry.url,
        retrievedAt: new Date(0).toISOString(),
        revision: entry.revision,
      },
    };
  }
}

function matches(entry: MockEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return false;
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle) ||
    entry.tags.some((tag) => tag.includes(needle)) ||
    (entry.text ?? '').toLowerCase().includes(needle)
  );
}

function cursorIndex(cursor: string | null): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createMockGithubProvider(options: MockProviderOptions = {}): ConnectedAppProvider {
  return new MockProvider(
    descriptor(
      'github',
      'GitHub',
      'Repositories, files and issues from a demo account.',
      [
        { id: 'repositories:read', description: 'List repositories.' },
        { id: 'contents:read', description: 'Read repository files.' },
        { id: 'issues:read', description: 'Read issues and pull requests.' },
      ],
      {
        list_resources: 'repositories:read',
        search_resources: 'contents:read',
        resource_metadata: 'contents:read',
        resource_content: 'contents:read',
      },
    ),
    GITHUB_ENTRIES,
    { accountId: 'acme-dev', displayName: 'Acme Developer', email: 'dev@acme.example' },
    options,
  );
}

export function createMockDriveProvider(options: MockProviderOptions = {}): ConnectedAppProvider {
  return new MockProvider(
    descriptor(
      'google_drive',
      'Google Drive',
      'Docs and files from a demo drive.',
      [
        { id: 'drive.metadata.readonly', description: 'List files and folders.' },
        { id: 'drive.readonly', description: 'Download file content.' },
      ],
      {
        list_resources: 'drive.metadata.readonly',
        search_resources: 'drive.metadata.readonly',
        resource_metadata: 'drive.metadata.readonly',
        resource_content: 'drive.readonly',
      },
    ),
    DRIVE_ENTRIES,
    { accountId: 'drive-demo', displayName: 'Acme Drive', email: 'drive@acme.example' },
    options,
  );
}

export function createMockNotionProvider(options: MockProviderOptions = {}): ConnectedAppProvider {
  return new MockProvider(
    descriptor(
      'notion',
      'Notion',
      'Pages and databases from a demo workspace.',
      [
        { id: 'pages:read', description: 'Search and read pages.' },
        { id: 'databases:read', description: 'Read database entries.' },
      ],
      {
        // In this simulation page and database reads share pages:read.
        list_resources: 'pages:read',
        search_resources: 'pages:read',
        resource_metadata: 'pages:read',
        resource_content: 'pages:read',
      },
    ),
    NOTION_ENTRIES,
    { accountId: 'notion-demo', displayName: 'Acme Workspace', email: 'workspace@acme.example' },
    options,
  );
}

export function createMockConnectedAppProviders(
  options: MockProviderOptions = {},
): readonly ConnectedAppProvider[] {
  return [
    createMockGithubProvider(options),
    createMockDriveProvider(options),
    createMockNotionProvider(options),
  ];
}

/** Test helper: builds a provider that delegates to a mock while overriding
 *  specific operations. Written as an object literal with arrow delegation so
 *  the mock's private state stays reachable (a spread copy would not). */
export function overrideProvider(
  base: ConnectedAppProvider,
  overrides: Partial<ConnectedAppProvider> & { readonly descriptor?: ProviderDescriptor },
): ConnectedAppProvider {
  return {
    descriptor: overrides.descriptor ?? base.descriptor,
    authenticate: (input) => base.authenticate(input),
    revoke: (input) => base.revoke(input),
    health: (input) => base.health(input),
    listResources: overrides.listResources ?? ((input) => base.listResources!(input)),
    searchResources: overrides.searchResources ?? ((input) => base.searchResources!(input)),
    getResource: overrides.getResource ?? ((input) => base.getResource!(input)),
    getContent: overrides.getContent ?? ((input) => base.getContent!(input)),
  };
}

export const MOCK_FIXTURES = {
  github: GITHUB_ENTRIES,
  drive: DRIVE_ENTRIES,
  notion: NOTION_ENTRIES,
} as const;

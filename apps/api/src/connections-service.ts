import {
  ConnectedAppManager,
  ConnectedResourceIntelligence,
  GitHubProvider,
  InMemoryCredentialVault,
  ProviderRegistry,
  type AuditSink,
  type HttpJsonTransport,
  type HttpJsonResponse,
  type ResourceAnalyzer,
} from '@veltravia/connected-apps-core';
import {
  createMockConnectedAppProviders,
  createMockGithubProvider,
} from '@veltravia/connected-apps-mock';
import {
  DEFAULT_DOCUMENT_LIMITS,
  inspectDocumentFormat,
  parseDocument,
} from '@veltravia/document-intelligence-core';

export interface ConnectionService {
  readonly manager: ConnectedAppManager;
  readonly intelligence: ConnectedResourceIntelligence;
  /** Provider modes this process actually runs, reported honestly to the UI. */
  readonly providerModes: Readonly<Record<string, 'live' | 'mock'>>;
  readonly githubAllowedRepositories: readonly string[];
}

export interface ConnectionServiceOptions {
  readonly now?: () => Date;
  readonly transport?: HttpJsonTransport;
  readonly onAudit?: AuditSink['record'];
}

/** Real HTTPS transport for the GitHub provider. Only used when a token is
 *  configured; CI and the default build run the deterministic mock instead. */
const liveTransport: HttpJsonTransport = {
  get: async (request): Promise<HttpJsonResponse> => {
    const response = await fetch(request.url, { headers: request.headers, signal: request.signal });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body };
  },
};

/** Adapter over Step 23 Document Intelligence: real format detection and
 *  parsing on connected bytes. The summary is a bounded EXTRACT of the parsed
 *  structure, not a model summary - no language model is called here, and the
 *  trust tag says so instead of implying generated prose. */
function createAnalyzer(): ResourceAnalyzer {
  const limits = {
    maxFileBytes: DEFAULT_DOCUMENT_LIMITS.maxFileBytes,
    maxElements: DEFAULT_DOCUMENT_LIMITS.maxElements,
    maxSections: DEFAULT_DOCUMENT_LIMITS.maxSections,
    maxTables: DEFAULT_DOCUMENT_LIMITS.maxTables,
    maxTableRows: DEFAULT_DOCUMENT_LIMITS.maxTableRows,
    maxSheetRows: DEFAULT_DOCUMENT_LIMITS.maxSheetRows,
    maxSlides: DEFAULT_DOCUMENT_LIMITS.maxSlides,
  } as const;

  const parse = (input: { filename: string; mimeType: string; bytes: Uint8Array }) => {
    const detected = inspectDocumentFormat(input.bytes);
    if (detected.format === 'unknown')
      throw new Error('That resource is not a supported document format.');
    return parseDocument(detected.format, input.bytes, 'connected-resource', limits);
  };

  return {
    analyze: async (input) => {
      const structure = parse(input);
      const text = structure.elements
        .flatMap((element) =>
          element.type === 'heading' || element.type === 'paragraph' ? [element.text] : [],
        )
        .join(' ')
        .trim();
      return {
        format: structure.format,
        elementCount: structure.elements.length,
        tableCount: structure.tables.length,
        headings: structure.elements
          .filter((element) => element.type === 'heading')
          .map((element) => element.text)
          .slice(0, 40),
        textPreview: text.slice(0, 2000),
        truncated: structure.truncated,
      };
    },
    summarize: async (input) => {
      const structure = parse(input);
      const headings = structure.elements
        .filter((element) => element.type === 'heading')
        .map((element) => element.text)
        .slice(0, input.mode === 'executive' ? 3 : 8);
      const firstParagraphs = structure.elements
        .filter((element) => element.type === 'paragraph')
        .map((element) => element.text)
        .slice(0, input.mode === 'brief' ? 2 : 5);
      const lines =
        input.mode === 'bullets'
          ? [
              ...headings.map((heading) => `- ${heading}`),
              ...firstParagraphs.map((text) => `- ${text}`),
            ]
          : [...headings, ...firstParagraphs];
      const summary = lines.join(input.mode === 'bullets' ? '\n' : ' ').trim();
      return {
        summary: summary.length > 0 ? summary : 'This document has no extractable text.',
        trustTag: 'structure_extract',
      };
    },
  };
}

/**
 * Builds the connected-app service.
 *
 * PROVIDER MODES (honest limitation, Step 24): Google Drive and Notion run the
 * DETERMINISTIC MOCK providers in this build - their real APIs are not
 * implemented. GitHub is live-capable: when CONNECTED_APPS_GITHUB_TOKEN and
 * CONNECTED_APPS_GITHUB_REPOS are set, the real provider is used; otherwise the
 * deterministic GitHub mock runs. Every response states which mode is active.
 */
export function createConnectionService(options: ConnectionServiceOptions): ConnectionService {
  const token = process.env.CONNECTED_APPS_GITHUB_TOKEN ?? '';
  const allowed = (process.env.CONNECTED_APPS_GITHUB_REPOS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const registry = new ProviderRegistry();
  const providerModes: Record<string, 'live' | 'mock'> = {};
  const useLiveGitHub = token.length > 0 && allowed.length > 0;

  if (useLiveGitHub) {
    registry.register(
      new GitHubProvider({
        allowedRepositories: allowed,
        transport: options.transport ?? liveTransport,
      }),
    );
    providerModes.github = 'live';
  } else {
    registry.register(createMockGithubProvider());
    providerModes.github = 'mock';
  }
  for (const provider of createMockConnectedAppProviders().slice(1)) {
    registry.register(provider);
    providerModes[provider.descriptor.id] = 'mock';
  }

  const vault = new InMemoryCredentialVault();
  const manager = new ConnectedAppManager({
    registry,
    vault,
    now: options.now,
    audit: options.onAudit ? { record: options.onAudit } : undefined,
  });
  const intelligence = new ConnectedResourceIntelligence(manager, createAnalyzer());
  return {
    manager,
    intelligence,
    providerModes,
    githubAllowedRepositories: useLiveGitHub ? allowed : [],
  };
}

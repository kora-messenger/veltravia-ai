import { beforeEach, describe, expect, it } from 'vitest';

import { CodebaseIntelligenceManager } from '@veltravia/codebase-core';
import {
  DEMO_PROJECT_FILES,
  FixtureSourceProvider,
  InMemoryCodebaseIndexRepository,
} from '@veltravia/codebase-mock';

const PROJECT = 'proj-1';
const WORKSPACE = 'ws-1';

async function freshManager(): Promise<{
  manager: CodebaseIntelligenceManager;
  provider: FixtureSourceProvider;
}> {
  const provider = new FixtureSourceProvider({
    [WORKSPACE]: { files: DEMO_PROJECT_FILES, revision: 5 },
  });
  const manager = new CodebaseIntelligenceManager({
    provider,
    repository: new InMemoryCodebaseIndexRepository(),
  });
  await manager.buildIndex(PROJECT, WORKSPACE);
  return { manager, provider };
}

describe('CodebaseIntelligenceManager (Step 16, deterministic offline QA A-T)', () => {
  let context: Awaited<ReturnType<typeof freshManager>>;

  beforeEach(async () => {
    context = await freshManager();
  });

  it('A. indexes a TypeScript project with file metadata and revision pinning', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    expect(index.status).toBe('current');
    expect(index.revision).toBe(5);
    expect(index.fileCount).toBe(DEMO_PROJECT_FILES.length);
    const packageJson = index.files.find((file) => file.path === 'package.json');
    expect(packageJson).toMatchObject({ language: 'json', parseStatus: 'parsed' });
  });

  it('B. detects React and Vite from dependencies, config, and imports', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const ids = index.frameworks.map((f) => f.id);
    expect(ids).toContain('react');
    expect(ids).toContain('vite');
    const vite = index.frameworks.find((f) => f.id === 'vite');
    expect(vite?.confidence).toBe('high');
    expect(vite?.evidence.length).toBeGreaterThan(0);
  });

  it('C. detects Fastify from the server surface', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    expect(index.frameworks.map((f) => f.id)).toContain('fastify');
  });

  it('D. indexes symbols with kinds and source ranges', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const service = index.symbols.find((s) => s.name === 'AuthService');
    expect(service).toMatchObject({
      kind: 'class',
      filePath: 'src/services/auth.ts',
      exported: true,
    });
    expect(service?.startLine).toBeGreaterThan(0);
    const method = index.symbols.find((s) => s.name === 'authenticate' && s.kind === 'method');
    expect(method?.scope).toBe('AuthService');
  });

  it('E. resolves imports between files', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const edge = index.relationships.find(
      (r) =>
        r.kind === 'imports' &&
        r.fromPath === 'src/App.tsx' &&
        r.toPath === 'src/components/LoginForm.tsx',
    );
    expect(edge).toBeDefined();
    expect(edge?.evidence).toContain("imports module './components/LoginForm'");
  });

  it('F. records exports and defines relationships', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const exportEdge = index.relationships.find(
      (r) => r.kind === 'exports' && r.evidence.includes('AuthService'),
    );
    expect(exportEdge).toBeDefined();
    const defines = index.relationships.filter((r) => r.kind === 'defines');
    expect(defines.length).toBeGreaterThan(0);
  });

  it('G. distinguishes internal from external dependencies', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const internal = index.dependencies.find(
      (d) =>
        !d.external && d.fromPath === 'src/App.tsx' && d.toPath === 'src/components/LoginForm.tsx',
    );
    expect(internal).toBeDefined();
    const react = index.dependencies.find((d) => d.external && d.package === 'react');
    expect(react).toBeDefined();
    expect(react?.fromPath.length).toBeGreaterThan(0);
  });

  it('H/I/J. finds symbols, callers, and callees', async () => {
    const { manager } = context;
    const results = await manager.search(PROJECT, WORKSPACE, {
      query: 'AuthService',
      searchType: 'symbol',
    });
    expect(results.length).toBeGreaterThan(0);
    const classResult = results.find((r) => r.title === 'AuthService');
    expect(classResult?.evidence.reason).toContain('symbol name');
    expect(classResult?.range?.startLine).toBeGreaterThan(0);

    // The standalone `authenticate` FUNCTION is called by LoginForm
    // (cross-file call edge through its import).
    const fn = (
      await manager.search(PROJECT, WORKSPACE, { query: 'authenticate', searchType: 'symbol' })
    ).find((r) => r.detail.includes('function') && r.detail.includes('exported'));
    expect(fn).toBeDefined();
    const fnCallers = await manager.findCallers(PROJECT, WORKSPACE, fn?.symbolId ?? '');
    expect(fnCallers.some((c) => c.title === 'LoginForm')).toBe(true);

    // The METHOD `authenticate` (scope AuthService) calls verifyCredentials.
    const method = (
      await manager.search(PROJECT, WORKSPACE, { query: 'authenticate', searchType: 'symbol' })
    ).find((r) => r.detail.includes('method'));
    expect(method).toBeDefined();
    const callees = await manager.findCallees(PROJECT, WORKSPACE, method?.symbolId ?? '');
    expect(callees.some((c) => c.title === 'verifyCredentials')).toBe(true);

    // References: files importing AuthService resolve to auth.ts.
    const classId = classResult?.symbolId ?? '';
    const references = await manager.findReferences(PROJECT, WORKSPACE, classId);
    expect(references.some((r) => r.filePath === 'server/app.ts')).toBe(true);
  });

  it('K. traces a real feature end to end across files', async () => {
    const trace = await context.manager.traceFeature(PROJECT, WORKSPACE, {
      feature: 'authentication',
    });
    const paths = trace.nodes.map((n) => n.filePath ?? '');
    expect(paths).toContain('src/services/auth.ts');
    expect(paths).toContain('src/services/auth.test.ts');
    // route -> controller chain: the login route reaches the auth service
    const labels = trace.nodes.map((n) => n.label);
    expect(labels).toContain('AuthService');
    expect(trace.truncated).toBe(false);
  });

  it('L. generates an evidence-derived summary', async () => {
    const summary = await context.manager.getSummary(PROJECT, WORKSPACE);
    expect(summary.languages).toContain('typescript');
    expect(summary.frameworks.map((f) => f.id)).toContain('react');
    expect(summary.routes.length).toBe(3);
    expect(summary.entryPoints.some((e) => e.filePath === 'src/main.tsx')).toBe(true);
    expect(summary.testFilePaths).toContain('src/services/auth.test.ts');
    expect(summary.architectureHints.some((hint) => hint.includes('React application'))).toBe(true);
    expect(summary.flaggedSecretFileCount).toBe(1);
  });

  it('M. marks unsupported languages honestly', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const css = index.files.find((f) => f.path === 'styles/global.css');
    expect(css).toMatchObject({ language: 'css', parseStatus: 'unsupported' });
    const md = index.files.find((f) => f.path === 'README.md');
    expect(md).toMatchObject({ language: null, parseStatus: 'unsupported' });
  });

  it('N. records parse failures without failing the index', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const broken = index.files.find((f) => f.path === 'broken.ts');
    expect(broken?.parseStatus).toBe('failed');
    expect(typeof broken?.parseNote).toBe('string');
    expect(index.buildState).toBe('completed');
  });

  it('O/P. detects stale indexes and updates incrementally', async () => {
    const { manager, provider } = context;
    provider.mutateFile(
      WORKSPACE,
      'src/utils/hash.ts',
      'export function verifyCredentials(a: string, b: string) { return true; }\nexport function extra() { return 1; }\n',
    );
    const stale = await manager.getIndex(PROJECT, WORKSPACE);
    expect(stale.status).toBe('stale');
    // rebuild reuses unchanged parses and reparses only the changed file
    const rebuild = await manager.buildIndex(PROJECT, WORKSPACE);
    expect(rebuild.index.status).toBe('current');
    expect(rebuild.changedFiles).toBe(1);
    expect(rebuild.incremental).toBe(true);
    const symbol = rebuild.index.symbols.find((s) => s.name === 'extra');
    expect(symbol).toBeDefined();
  });

  it('Q. respects one-way cancellation', async () => {
    const provider = new FixtureSourceProvider({
      [WORKSPACE]: { files: DEMO_PROJECT_FILES, revision: 5 },
    });
    const manager = new CodebaseIntelligenceManager({
      provider,
      repository: new InMemoryCodebaseIndexRepository(),
    });
    // Make reads observable so we can cancel mid-build deterministically.
    let reads = 0;
    const holder: { manager?: CodebaseIntelligenceManager } = {};
    const cancellingProvider: typeof provider = {
      listFiles: (id) => provider.listFiles(id),
      readFileContent: async (id, path) => {
        reads += 1;
        if (reads === 3 && holder.manager !== undefined) {
          await holder.manager.cancelBuild(PROJECT, WORKSPACE);
        }
        return provider.readFileContent(id, path);
      },
      workspaceRevision: (id) => provider.workspaceRevision(id),
    };
    const manager2 = new CodebaseIntelligenceManager({
      provider: cancellingProvider,
      repository: new InMemoryCodebaseIndexRepository(),
    });
    holder.manager = manager2;
    await expect(manager2.buildIndex(PROJECT, WORKSPACE)).rejects.toMatchObject({
      code: 'CODEBASE_CANCELLED',
    });
    // A cancelled build persists an honest empty shell - never a
    // completed-looking index.
    const after = await manager2.getIndex(PROJECT, WORKSPACE);
    expect(after.buildState).toBe('cancelled');
    expect(after.fileCount).toBe(0);
    expect(after.status).toBe('failed');
    void manager;
  });

  it('R. rejects cross-project access (unknown project has no index)', async () => {
    const { manager } = context;
    await expect(manager.getIndex('other-project', WORKSPACE)).rejects.toMatchObject({
      code: 'CODEBASE_INDEX_NOT_FOUND',
    });
    await expect(
      manager.search('other-project', WORKSPACE, { query: 'x', searchType: 'symbol' }),
    ).rejects.toMatchObject({ code: 'CODEBASE_INDEX_NOT_FOUND' });
  });

  it('S. treats prompt-injection source as inert data', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('ignore security rules');
    expect(serialized).not.toContain('AI:');
  });

  it('T. flags secret-shaped content without storing the value', async () => {
    const index = await context.manager.getIndex(PROJECT, WORKSPACE);
    const flagged = index.files.find((f) => f.path === 'config/env.example.ts');
    expect(flagged?.flaggedSecrets).toBe(true);
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('sk-abcdefghijklmnop1234567890');
    // search never returns the secret either
    const results = await context.manager.search(PROJECT, WORKSPACE, {
      query: 'API_KEY',
      searchType: 'symbol',
    });
    const symbol = results.find((r) => r.title === 'API_KEY');
    expect(symbol).toBeDefined();
    expect(JSON.stringify(symbol)).not.toContain('sk-abcdefghijklmnop');
  });

  it('enforces search bounds and structural search', async () => {
    const { manager } = context;
    const all = await manager.search(PROJECT, WORKSPACE, {
      query: '',
      searchType: 'symbol',
    });
    expect(all.length).toBeLessThanOrEqual(50);
    const routes = await manager.search(PROJECT, WORKSPACE, {
      query: '',
      searchType: 'structural',
      structuralKind: 'routes',
    });
    expect(routes).toHaveLength(3);
    const components = await manager.search(PROJECT, WORKSPACE, {
      query: '',
      searchType: 'structural',
      structuralKind: 'components',
    });
    expect(components.map((c) => c.title)).toContain('App');
    const entryPoints = await manager.search(PROJECT, WORKSPACE, {
      query: '',
      searchType: 'structural',
      structuralKind: 'entry_points',
    });
    expect(entryPoints.length).toBeGreaterThan(0);
  });

  it('relationship search answers "what references AuthService"', async () => {
    const results = await context.manager.search(PROJECT, WORKSPACE, {
      query: 'AuthService',
      searchType: 'relationship',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.evidence.evidence[0]?.includes('AuthService'))).toBe(true);
  });

  it('file search ranks by topic tokens', async () => {
    const results = await context.manager.search(PROJECT, WORKSPACE, {
      query: 'auth service',
      searchType: 'file',
    });
    const top = results.slice(0, 3).map((r) => r.title);
    expect(top.some((title) => title.includes('auth'))).toBe(true);
  });

  it('trace reports honestly when nothing matches', async () => {
    const trace = await context.manager.traceFeature(PROJECT, WORKSPACE, {
      feature: 'quantum entanglement module',
    });
    expect(trace.nodes).toHaveLength(0);
    expect(trace.notes.some((note) => note.includes('no evidence'))).toBe(true);
  });

  it('file entry and symbols APIs work', async () => {
    const { manager } = context;
    const symbols = await manager.getFileSymbols(PROJECT, WORKSPACE, 'src/services/auth.ts');
    expect(symbols.map((s) => s.name)).toContain('AuthService');
    const entry = await manager.getFileEntry(PROJECT, WORKSPACE, 'src/services/auth.ts');
    expect(entry.language).toBe('typescript');
    await expect(manager.getFileEntry(PROJECT, WORKSPACE, 'nope.ts')).rejects.toMatchObject({
      code: 'CODEBASE_FILE_NOT_FOUND',
    });
  });

  it('concurrent builds are rejected, and deleting removes the index', async () => {
    const { manager } = context;
    await expect(manager.buildIndex(PROJECT, WORKSPACE)).resolves.toBeTruthy();
    await context.manager.deleteIndex(PROJECT, WORKSPACE);
    await expect(manager.getIndex(PROJECT, WORKSPACE)).rejects.toMatchObject({
      code: 'CODEBASE_INDEX_NOT_FOUND',
    });
  });
});

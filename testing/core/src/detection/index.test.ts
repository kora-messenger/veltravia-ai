import { describe, expect, it } from 'vitest';

import {
  MANIFEST_PATH,
  detectProject,
  parseScriptCommand,
  rederiveScriptCommand,
  type FileNodeView,
} from './index.js';

const NODES: readonly FileNodeView[] = [
  { path: MANIFEST_PATH, type: 'file' },
  { path: 'tsconfig.json', type: 'file' },
  { path: 'vite.config.ts', type: 'file' },
  { path: 'src', type: 'directory' },
  { path: 'tests', type: 'directory' },
];

function manifest(scripts: Record<string, string>, extra: Record<string, unknown> = {}): unknown {
  return { name: 'fixture', scripts, ...extra };
}

describe('parseScriptCommand', () => {
  it('derives a structural command from a bare script', () => {
    expect(parseScriptCommand('test', 'node --version')).toEqual({
      executable: 'node',
      arguments: ['--version'],
      purpose: 'test',
      label: 'npm script "test"',
      scriptName: 'test',
    });
    expect(parseScriptCommand('test', 'npm run build --silent')?.executable).toBe('npm');
  });

  it('rejects shell-shaped and unknown-executable scripts', () => {
    expect(parseScriptCommand('test', 'node --version; rm -rf /')).toBeNull();
    expect(parseScriptCommand('test', 'bash run.sh')).toBeNull();
    expect(parseScriptCommand('test', './scripts/test.sh')).toBeNull();
    expect(parseScriptCommand('test', '')).toBeNull();
  });

  it('rejects secret-shaped script arguments', () => {
    expect(parseScriptCommand('test', 'node --key ghp_abcdefghijklmnopqrst')).toBeNull();
  });
});

describe('detectProject', () => {
  it('detects a web project with a test script and derives commands', () => {
    const result = detectProject({
      nodes: NODES,
      manifest: manifest(
        { test: 'node --version', build: 'node --version' },
        { dependencies: { react: '*' } },
      ),
      manifestBytes: 64,
    });
    expect(result.detection.projectType).toBe('web');
    expect(result.detection.framework).toBe('React');
    expect(result.detection.testScript).toBe('node --version');
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]?.purpose).toBe('test');
    expect(result.commands[1]?.purpose).toBe('build');
    const kinds = result.detection.signals.map((signal) => signal.kind);
    expect(kinds).toContain('package-manifest');
    expect(kinds).toContain('test-script');
    expect(kinds).toContain('react-dependency');
  });

  it('detects a fullstack project (react + fastify)', () => {
    const result = detectProject({
      nodes: NODES,
      manifest: manifest(
        { test: 'node --version' },
        { dependencies: { react: '*', fastify: '*' } },
      ),
      manifestBytes: 64,
    });
    expect(result.detection.projectType).toBe('fullstack');
  });

  it('is honest when the test script is not derivable or missing', () => {
    const notDerivable = detectProject({
      nodes: NODES,
      manifest: manifest({ test: 'bash run.sh' }),
      manifestBytes: 64,
    });
    expect(notDerivable.commands).toHaveLength(0);
    expect(notDerivable.detection.notes.join(' ')).toMatch(/not a derivable bare command/);

    const missing = detectProject({
      nodes: NODES,
      manifest: manifest({ build: 'node --version' }),
      manifestBytes: 64,
    });
    expect(missing.detection.notes.join(' ')).toMatch(/no "test" script/);
  });

  it('treats unparseable manifest content as tree-only detection (plain Node backend)', () => {
    const result = detectProject({ nodes: NODES, manifest: null, manifestBytes: null });
    expect(result.detection.projectType).toBe('backend');
    expect(result.detection.notes.join(' ')).toMatch(/could not be parsed/);
    expect(result.detection.notes.join(' ')).toMatch(/plain Node backend/);
  });

  it('marks an empty workspace unknown honestly', () => {
    const result = detectProject({ nodes: [], manifest: null, manifestBytes: null });
    expect(result.detection.projectType).toBe('unknown');
    expect(result.detection.notes.join(' ')).toMatch(/could not be determined/);
  });

  it('caps oversized manifests to tree-only detection', () => {
    const result = detectProject({
      nodes: NODES,
      manifest: null,
      manifestBytes: 65_537,
    });
    expect(result.detection.notes.join(' ')).toMatch(/too large to read/);
  });
});

describe('rederiveScriptCommand', () => {
  it('re-derives from the CURRENT manifest value', () => {
    expect(rederiveScriptCommand('test', manifest({ test: 'node --version' }))).not.toBeNull();
    expect(rederiveScriptCommand('test', manifest({ test: 'node --version' }))?.arguments).toEqual([
      '--version',
    ]);
  });

  it('returns null when the script is gone and throws when no longer derivable', () => {
    expect(rederiveScriptCommand('test', manifest({}))).toBeNull();
    expect(() => rederiveScriptCommand('test', manifest({ test: 'bash run.sh' }))).toThrowError(
      /no longer a derivable bare command/,
    );
  });
});

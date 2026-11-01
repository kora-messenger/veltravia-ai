import { describe, expect, it } from 'vitest';

import { AppBuilderError } from '../errors/index.js';
import { LanguageFrameworkRegistry } from './index.js';
import type { FrameworkEntry, LanguageEntry } from '../types/index.js';

function language(overrides: Partial<LanguageEntry> = {}): LanguageEntry {
  return {
    kind: 'language',
    id: 'testlang',
    name: 'Test Language',
    layer: 'backend',
    versions: ['1'],
    packageManagers: [],
    runtime: { runtimes: ['test'], compiled: false },
    preview: { mode: 'none', ports: [], note: 'Nothing to preview.' },
    deployment: { targets: ['container'], note: 'Planned only.' },
    unsupported: [],
    supportLevel: 'planned',
    fileExtensions: ['.tl'],
    manifestFiles: ['testmanifest.txt'],
    ...overrides,
  };
}

function framework(overrides: Partial<FrameworkEntry> = {}): FrameworkEntry {
  return {
    kind: 'framework',
    id: 'testframe',
    name: 'TestFramework',
    languageId: 'testlang',
    layer: 'backend',
    projectKinds: ['backend'],
    versions: ['1'],
    packageManagers: [],
    runtime: { runtimes: ['test'], compiled: false },
    preview: { mode: 'none', ports: [], note: 'Nothing to preview.' },
    deployment: { targets: ['container'], note: 'Planned only.' },
    unsupported: [],
    supportLevel: 'planned',
    dependencySignals: ['testframe'],
    manifestFiles: [],
    ...overrides,
  };
}

function freshRegistry(): LanguageFrameworkRegistry {
  return new LanguageFrameworkRegistry(false);
}

describe('capability registry', () => {
  it('ships a catalog that covers every technology family the product promises', () => {
    const registry = new LanguageFrameworkRegistry();
    const ids = registry.list().map((entry) => entry.id);

    for (const expected of [
      'react',
      'nextjs',
      'vue',
      'angular',
      'svelte',
      'html',
      'javascript',
      'python',
      'php',
      'java',
      'csharp',
      'go',
      'ruby',
      'dart',
      'kotlin',
      'swift',
      'c',
      'cpp',
      'rust',
      'sql',
      'solidity',
      'bash',
      'flutter',
      'react-native',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('never claims execution support for a language in this release', () => {
    const registry = new LanguageFrameworkRegistry();
    const executable = registry.list().filter((entry) => entry.supportLevel === 'executable');
    expect(executable).toHaveLength(0);
  });

  it('records honest gaps for every entry', () => {
    const registry = new LanguageFrameworkRegistry();
    for (const entry of registry.list()) {
      expect(entry.preview.note.length).toBeGreaterThan(0);
      expect(entry.deployment.note.length).toBeGreaterThan(0);
      expect(entry.unsupported.length).toBeGreaterThan(0);
    }
  });

  it('resolves frameworks by layer and project kind', () => {
    const registry = new LanguageFrameworkRegistry();
    const backend = registry.byLayer('backend').map((entry) => entry.id);
    expect(backend).toContain('node-fastify');
    expect(backend).toContain('django');

    const mobile = registry.forProjectKind('mobile').map((entry) => entry.id);
    expect(mobile).toContain('flutter');
    expect(mobile).toContain('react-native');
    expect(mobile).not.toContain('react');
  });

  it('links frameworks to their language', () => {
    const registry = new LanguageFrameworkRegistry();
    expect(registry.frameworksFor('dart').map((entry) => entry.id)).toEqual(['flutter']);
    expect(
      registry
        .frameworksFor('python')
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['django', 'flask']);
  });

  it('rejects an unknown technology with a scrubbed error', () => {
    const registry = new LanguageFrameworkRegistry();
    expect(() => registry.get('cobol')).toThrow(AppBuilderError);
    try {
      registry.get('cobol');
    } catch (error) {
      expect((error as AppBuilderError).code).toBe('APP_BUILDER_UNKNOWN_TECHNOLOGY');
    }
  });

  it('rejects a framework whose language is missing', () => {
    const registry = freshRegistry();
    expect(() => registry.register(framework())).toThrow(AppBuilderError);
  });

  it('rejects duplicate ids', () => {
    const registry = freshRegistry();
    registry.register(language());
    expect(() => registry.register(language())).toThrow(/already exists/);
  });

  it('rejects a shell command smuggled through argv', () => {
    const registry = freshRegistry();
    expect(() =>
      registry.register(
        language({
          build: { argv: ['bash', '-c', 'rm -rf /'], description: 'build', maxSeconds: 60 },
        }),
      ),
    ).toThrow(/shell/);
  });

  it('rejects shell syntax inside an argument', () => {
    const registry = freshRegistry();
    expect(() =>
      registry.register(
        language({
          test: { argv: ['node', 'test.js && curl evil'], description: 'test', maxSeconds: 60 },
        }),
      ),
    ).toThrow(/shell syntax/);
  });

  it('rejects a credential pasted into an entry', () => {
    const registry = freshRegistry();
    expect(() => registry.register(language({ name: 'sk-abcdefghijklmnopqrstuvwx' }))).toThrow(
      /credential/,
    );
  });

  it('rejects an invalid version string', () => {
    const registry = freshRegistry();
    expect(() => registry.register(language({ versions: ['latest-ish?'] }))).toThrow(
      /not a version/,
    );
  });

  it('rejects an out-of-range command timeout', () => {
    const registry = freshRegistry();
    expect(() =>
      registry.register(
        language({ build: { argv: ['make'], description: 'build', maxSeconds: 0 } }),
      ),
    ).toThrow(/timeout/);
  });

  it('allows replacing a catalog entry through upsert', () => {
    const registry = freshRegistry();
    registry.register(language());
    registry.upsert(language({ supportLevel: 'scaffold' }));
    expect(registry.supportLevelOf('testlang')).toBe('scaffold');
  });

  it('accepts a new language without touching the builder', () => {
    const registry = new LanguageFrameworkRegistry();
    registry.register(
      language({
        id: 'elixir',
        name: 'Elixir',
        fileExtensions: ['.ex'],
        manifestFiles: ['mix.exs'],
      }),
    );
    registry.register(
      framework({
        id: 'phoenix',
        name: 'Phoenix',
        languageId: 'elixir',
        dependencySignals: ['phoenix'],
      }),
    );
    expect(registry.frameworksFor('elixir').map((entry) => entry.id)).toEqual(['phoenix']);
  });
});

import { describe, expect, it } from 'vitest';

import { AppBuilderError } from '../errors/index.js';
import { LanguageFrameworkRegistry } from '../registry/index.js';
import { TechnologyStackDetector } from './index.js';
import type { ManifestFile } from '../types/index.js';

const detector = new TechnologyStackDetector(new LanguageFrameworkRegistry());

function detect(files: ManifestFile[]) {
  return detector.detect(files);
}

describe('technology stack detection', () => {
  it('detects React from a manifest and a component file', () => {
    const result = detect([
      {
        path: 'package.json',
        text: JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
      },
      { path: 'src/App.jsx' },
    ]);
    expect(result.frameworks[0]?.id).toBe('react');
    expect(result.languages.map((language) => language.id)).toContain('javascript');
  });

  it('does not claim a framework from a stray file', () => {
    const result = detect([{ path: 'notes.txt' }, { path: 'readme.md' }]);
    expect(result.frameworks).toHaveLength(0);
    expect(result.languages).toHaveLength(0);
  });

  it('says plainly when there was nothing to inspect', () => {
    expect(detect([]).notes.join(' ')).toMatch(/no files to inspect/i);
  });

  it('detects Python from requirements and source files', () => {
    const result = detect([
      { path: 'requirements.txt', text: 'django==5.0\npytest==8.3\n' },
      { path: 'manage.py' },
      { path: 'app/models.py' },
    ]);
    expect(result.languages[0]?.id).toBe('python');
    expect(result.frameworks.map((framework) => framework.id)).toContain('django');
  });

  it('detects Flutter from pubspec and Dart sources', () => {
    const result = detect([
      { path: 'pubspec.yaml', text: 'dependencies:\n  flutter:\n    sdk: flutter\n' },
      { path: 'lib/main.dart' },
    ]);
    expect(result.frameworks.map((framework) => framework.id)).toContain('flutter');
    expect(result.languages.map((language) => language.id)).toContain('dart');
  });

  it('implies the language of a detected framework', () => {
    const result = detect([{ path: 'angular.json' }, { path: 'src/app.component.ts' }]);
    expect(result.frameworks.map((framework) => framework.id)).toContain('angular');
    expect(result.languages.map((language) => language.id)).toContain('typescript');
  });

  it('reports a language the registry does not know instead of dropping it', () => {
    const result = detect([{ path: 'main.lua' }, { path: 'lib.lua' }]);
    expect(result.unknownLanguages).toContain('Lua');
    expect(result.notes.join(' ')).toMatch(/not in the registry/);
  });

  it('ranks confidence by evidence weight', () => {
    const thin = detect([{ path: 'a.py' }]);
    const thick = detect([
      { path: 'requirements.txt', text: 'flask\n' },
      { path: 'app.py' },
      { path: 'tests/test_app.py' },
    ]);
    const thinPython = thin.languages.find((language) => language.id === 'python');
    const thickPython = thick.languages.find((language) => language.id === 'python');
    expect(thickPython!.confidence).toBeGreaterThan(thinPython!.confidence);
  });

  it('matches glob manifest patterns like *.csproj', () => {
    const result = detect([{ path: 'src/Api.csproj' }, { path: 'Program.cs' }]);
    expect(result.languages.map((language) => language.id)).toContain('csharp');
  });

  it('detects Go from go.mod and go.sum', () => {
    const result = detect([{ path: 'go.mod' }, { path: 'go.sum' }, { path: 'main.go' }]);
    expect(result.languages[0]?.id).toBe('go');
  });

  it('says a detected stack cannot be built when its support level is planned', () => {
    const result = detect([{ path: 'pom.xml' }, { path: 'src/Main.java' }]);
    expect(result.notes.join(' ')).toMatch(/cannot yet build/);
  });

  it('counts files it did not recognise', () => {
    const result = detect([{ path: 'package.json', text: '{}' }, { path: 'assets/logo.bin' }]);
    expect(result.unrecognisedFiles).toBe(1);
  });

  it('rejects an oversized manifest', () => {
    const files: ManifestFile[] = Array.from({ length: 5_001 }, (_, index) => ({
      path: `file-${index}.js`,
    }));
    expect(() => detect(files)).toThrow(AppBuilderError);
  });

  it('is deterministic for the same input', () => {
    const files: ManifestFile[] = [{ path: 'package.json', text: '{"dependencies":{"vue":"3"}}' }];
    expect(JSON.stringify(detect(files))).toBe(JSON.stringify(detect(files)));
  });
});

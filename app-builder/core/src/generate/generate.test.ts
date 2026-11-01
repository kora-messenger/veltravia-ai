import { describe, expect, it } from 'vitest';

import { AppBuilderError } from '../errors/index.js';
import { LanguageFrameworkRegistry } from '../registry/index.js';
import { buildScaffoldPlan } from './index.js';
import { hasTemplate, TEMPLATES } from './templates.js';

const registry = new LanguageFrameworkRegistry();

function plan(specification: unknown, id = 'plan_1') {
  return buildScaffoldPlan(
    { ownerRef: 'owner-1', specification, planId: id, now: '2026-10-31T00:00:00.000Z' },
    registry,
  );
}

describe('scaffold generation', () => {
  it('generates a React application with real starter files', () => {
    const built = plan({
      name: 'Invoice Desk',
      description: 'Invoices.',
      projectKind: 'web',
      frontend: 'react',
    });
    const paths = built.files.map((file) => file.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('README.md');
    expect(paths).toContain('veltravia.project.json');
    expect(built.buildCommand?.argv).toEqual(['npm', 'run', 'build']);
    expect(built.preview.mode).toBe('static');
  });

  it('writes the specification it was built from, so the project is self-describing', () => {
    const built = plan({
      name: 'Invoice Desk',
      description: 'Invoices.',
      projectKind: 'web',
      frontend: 'react',
    });
    const record = built.files.find((file) => file.path === 'veltravia.project.json');
    const parsed = JSON.parse(record!.content) as { name: string; frontend: string };
    expect(parsed.name).toBe('Invoice Desk');
    expect(parsed.frontend).toBe('react');
  });

  it('generates a Python service with a test that asserts something', () => {
    const built = plan({
      name: 'Ledger',
      description: 'Ledger service.',
      projectKind: 'backend',
      backend: 'python',
    });
    const test = built.files.find((file) => file.path === 'tests/test_main.py');
    expect(test?.content).toContain('assert greet');
    expect(built.testCommand?.argv).toEqual(['python3', '-m', 'pytest', '-q']);
  });

  it('generates a Go service and its handler test', () => {
    const built = plan({ name: 'Gateway', description: '', projectKind: 'backend', backend: 'go' });
    expect(built.files.map((file) => file.path)).toEqual([
      'go.mod',
      'main.go',
      'main_test.go',
      'README.md',
      '.gitignore',
      'veltravia.project.json',
    ]);
  });

  it('generates a Flutter app for a mobile specification', () => {
    const built = plan({
      name: 'Pocket',
      description: '',
      projectKind: 'mobile',
      mobile: 'flutter',
    });
    expect(built.files.map((file) => file.path)).toContain('lib/main.dart');
    expect(built.preview.mode).toBe('device-emulator');
  });

  it('combines frontend and backend files for a full-stack project', () => {
    const built = plan({
      name: 'Shopfront',
      description: '',
      projectKind: 'fullstack',
      frontend: 'react',
      backend: 'node-fastify',
    });
    const paths = built.files.map((file) => file.path);
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('src/server.ts');
    // The first stack role owns the shared manifest, so nothing is overwritten.
    expect(paths.filter((path) => path === 'package.json')).toHaveLength(1);
  });

  it('refuses a stack it cannot scaffold instead of replacing it', () => {
    expect(() =>
      plan({ name: 'Spring', description: '', projectKind: 'backend', backend: 'spring-boot' }),
    ).toThrow(AppBuilderError);

    try {
      plan({ name: 'Spring', description: '', projectKind: 'backend', backend: 'spring-boot' });
    } catch (error) {
      const typed = error as AppBuilderError;
      expect(typed.code).toBe('APP_BUILDER_UNSUPPORTED_TECHNOLOGY');
      expect(typed.message).toMatch(/was not replaced/);
      expect(typed.details['technologies']).toEqual(['spring-boot']);
    }
  });

  it('refuses an entire project when one part of the stack is unsupported', () => {
    expect(() =>
      plan({
        name: 'Mixed',
        description: '',
        projectKind: 'fullstack',
        frontend: 'react',
        backend: 'django',
      }),
    ).toThrow(/cannot scaffold/);
  });

  it('never emits a path that escapes the workspace', () => {
    const built = plan({
      name: 'Invoice Desk',
      description: '',
      projectKind: 'web',
      frontend: 'react',
    });
    for (const file of built.files) {
      expect(file.path.startsWith('/')).toBe(false);
      expect(file.path.includes('..')).toBe(false);
    }
  });

  it('is deterministic: the same specification produces the same bytes', () => {
    const spec = { name: 'Repeat', description: 'Same.', projectKind: 'web', frontend: 'react' };
    expect(JSON.stringify(plan(spec, 'a').files)).toBe(JSON.stringify(plan(spec, 'b').files));
  });

  it('escapes user text in generated HTML', () => {
    const built = plan({
      name: 'Static Site',
      description: '<img src=x onerror=alert(1)>',
      projectKind: 'web',
      frontend: 'html',
    });
    const html = built.files.find((file) => file.path === 'index.html');
    expect(html?.content).not.toContain('<script>alert');
    expect(html?.content).toContain('&lt;img');
  });

  it('only offers templates for entries the registry marks scaffoldable', () => {
    for (const id of Object.keys(TEMPLATES)) {
      const entry = registry.get(id);
      expect(hasTemplate(id)).toBe(true);
      expect(entry.supportLevel).not.toBe('planned');
    }
  });

  it('carries the review so a caller can see support levels with the plan', () => {
    const built = plan({
      name: 'Invoice Desk',
      description: '',
      projectKind: 'web',
      frontend: 'react',
    });
    expect(built.review.valid).toBe(true);
    expect(built.review.supportLevel).toBe('scaffold');
  });
});

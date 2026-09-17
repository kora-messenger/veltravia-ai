import { describe, expect, it } from 'vitest';

import { GenerationError } from '../errors/index.js';
import { TemplateRegistry } from './index.js';
import {
  FULLSTACK_REACT_FASTIFY_TEMPLATE,
  WEB_REACT_TEMPLATE,
  createDefaultTemplateRegistry,
} from './index.js';
import type { AppSpecification, ProjectTemplate } from '../types/index.js';

function spec(name = 'Task Manager'): AppSpecification {
  return {
    name,
    description: 'A small task management application.',
    appType: 'web',
    targetPlatform: 'web',
    features: ['tasks', 'dashboard'],
    screens: [
      { name: 'Dashboard', description: 'An overview of everything at a glance.' },
      { name: 'Tasks' },
    ],
    entities: [{ name: 'Task', fields: [{ name: 'id', type: 'string' }] }],
    integrations: [],
    constraints: [],
    version: '0.1.0',
    generatedAt: '2026-09-17T08:00:00.000Z',
  };
}

describe('TemplateRegistry', () => {
  it('registers and lists templates', () => {
    const registry = new TemplateRegistry();
    registry.register(WEB_REACT_TEMPLATE);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('web-react').id).toBe('web-react');
  });

  it('rejects duplicate template ids', () => {
    const registry = new TemplateRegistry();
    registry.register(WEB_REACT_TEMPLATE);
    expect(() => registry.register(WEB_REACT_TEMPLATE)).toThrow(GenerationError);
  });

  it('fails honestly for unknown templates', () => {
    const registry = createDefaultTemplateRegistry();
    let caught: unknown;
    try {
      registry.get('mobile-flutter');
    } catch (error) {
      caught = error;
    }
    expect((caught as GenerationError).code).toBe('GENERATION_UNSUPPORTED_TEMPLATE');
  });
});

describe('WEB_REACT_TEMPLATE', () => {
  it('supports only the web application type', () => {
    expect(WEB_REACT_TEMPLATE.supportedAppTypes).toEqual(['web']);
  });

  it('generates deterministic starter files covering its own required files', () => {
    const files = WEB_REACT_TEMPLATE.generateFiles(spec());
    const paths = files.map((file) => file.path);
    for (const required of WEB_REACT_TEMPLATE.validationRules.requiredFiles) {
      expect(paths).toContain(required);
    }
    expect(paths).toContain('src/pages/Dashboard.tsx');
    expect(paths).toContain('src/pages/Tasks.tsx');
  });

  it('is deterministic: the same spec always yields the same files', () => {
    const first = WEB_REACT_TEMPLATE.generateFiles(spec());
    const second = WEB_REACT_TEMPLATE.generateFiles(spec());
    expect(first).toEqual(second);
  });

  it('embeds spec-derived content (name, description) in generated files', () => {
    const files = WEB_REACT_TEMPLATE.generateFiles(spec('Team Board'));
    const readme = files.find((file) => file.path === 'README.md');
    expect(readme?.content).toContain('Team Board');
    const index = files.find((file) => file.path === 'index.html');
    expect(index?.content).toContain('Team Board');
  });

  it('produces a parseable package.json manifest', () => {
    const files = WEB_REACT_TEMPLATE.generateFiles(spec());
    const manifest = files.find((file) => file.path === 'package.json');
    expect(() => JSON.parse(manifest?.content ?? '')).not.toThrow();
  });
});

describe('FULLSTACK_REACT_FASTIFY_TEMPLATE', () => {
  it('supports the fullstack application type', () => {
    expect(FULLSTACK_REACT_FASTIFY_TEMPLATE.supportedAppTypes).toEqual(['fullstack']);
  });

  it('generates web files plus the API server, covering its required files', () => {
    const fullSpec = {
      ...spec(),
      appType: 'fullstack' as const,
      targetPlatform: 'web+server' as const,
    };
    const files = FULLSTACK_REACT_FASTIFY_TEMPLATE.generateFiles(fullSpec);
    const paths = files.map((file) => file.path);
    for (const required of FULLSTACK_REACT_FASTIFY_TEMPLATE.validationRules.requiredFiles) {
      expect(paths).toContain(required);
    }
    expect(paths).toContain('server/index.ts');
    const manifest = files.find((file) => file.path === 'package.json');
    expect(manifest?.content).toContain('fastify');
  });

  it('declares structured test commands only (no shells, no arbitrary strings)', () => {
    for (const command of FULLSTACK_REACT_FASTIFY_TEMPLATE.testCommands) {
      expect(typeof command.command).toBe('string');
      expect(Array.isArray(command.arguments)).toBe(true);
      expect(command.purpose.length).toBeGreaterThan(0);
    }
  });
});

describe('built-in registry', () => {
  it('contains exactly the implemented templates', () => {
    const registry = createDefaultTemplateRegistry();
    const ids = registry
      .list()
      .map((template: ProjectTemplate) => template.id)
      .sort();
    expect(ids).toEqual(['fullstack-react-fastify', 'web-react']);
  });
});

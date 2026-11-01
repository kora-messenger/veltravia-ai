import { describe, expect, it } from 'vitest';

import { AppBuilderError } from '../errors/index.js';
import { LanguageFrameworkRegistry } from '../registry/index.js';
import {
  assertValidSpecification,
  compareRequestedStack,
  validateProjectSpecification,
} from './index.js';
import type { StackDetection } from '../types/index.js';

const registry = new LanguageFrameworkRegistry();

function webSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Invoice Desk',
    description: 'Small invoicing web app.',
    projectKind: 'web',
    frontend: 'react',
    ...overrides,
  };
}

describe('project specification validation', () => {
  it('accepts a minimal web specification and resolves its stack', () => {
    const review = validateProjectSpecification(webSpec(), registry);
    expect(review.valid).toBe(true);
    expect(review.resolved.map((entry) => entry.id)).toEqual(['react']);
    expect(review.supportLevel).toBe('scaffold');
  });

  it('accepts a full-stack specification with both roles', () => {
    const review = validateProjectSpecification(
      webSpec({ projectKind: 'fullstack', backend: 'node-fastify' }),
      registry,
    );
    expect(review.valid).toBe(true);
    expect(review.resolved.map((entry) => entry.role)).toEqual(['frontend', 'backend']);
  });

  it('requires a frontend for a web project', () => {
    const review = validateProjectSpecification({ name: 'Bare', projectKind: 'web' }, registry);
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('required-for-kind');
  });

  it('requires a mobile framework for a mobile project', () => {
    const review = validateProjectSpecification(
      { name: 'Pocket', projectKind: 'mobile', frontend: 'react' },
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.message).join(' ')).toMatch(/mobile/);
  });

  it('rejects an unknown technology instead of guessing', () => {
    const review = validateProjectSpecification(webSpec({ frontend: 'qwik' }), registry);
    expect(review.valid).toBe(false);
    expect(review.issues[0]?.code).toBe('unknown-technology');
  });

  it('rejects a technology in the wrong role', () => {
    const review = validateProjectSpecification(webSpec({ frontend: 'django' }), registry);
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('wrong-layer');
  });

  it('rejects unknown fields so a typo never silently passes', () => {
    const review = validateProjectSpecification(webSpec({ frontendFramework: 'react' }), registry);
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.path)).toContain('frontendFramework');
  });

  it('rejects a specification that is not an object', () => {
    expect(validateProjectSpecification('make me an app', registry).valid).toBe(false);
  });

  it('rejects an unsafe build output path', () => {
    const review = validateProjectSpecification(
      webSpec({ build: { outputDirectory: '../../etc' } }),
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('unsafe-path');
  });

  it('refuses build commands supplied by the caller', () => {
    const review = validateProjectSpecification(
      webSpec({
        build: { buildCommand: { argv: ['rm', '-rf', '/'], description: 'x', maxSeconds: 10 } },
      }),
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('not-accepted');
  });

  it('refuses environment values and asks for names only', () => {
    const review = validateProjectSpecification(
      webSpec({ environment: ['DATABASE_URL=postgres://user:pass@host/db'] }),
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues[0]?.message).toMatch(/NAMES only/);
  });

  it('rejects a credential pasted into a constraint', () => {
    const review = validateProjectSpecification(
      webSpec({ constraints: ['api_key: sk-live-abcdefghijklmnop'] }),
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('secret-shaped');
  });

  it('rejects an unknown authentication strategy', () => {
    const review = validateProjectSpecification(
      webSpec({ authentication: { strategy: 'magic-link-please', providers: [] } }),
      registry,
    );
    expect(review.valid).toBe(false);
    expect(review.issues[0]?.path).toBe('authentication.strategy');
  });

  it('accepts a documented strategy and integrations', () => {
    const review = validateProjectSpecification(
      webSpec({
        authentication: { strategy: 'email-password', providers: [] },
        apis: [{ name: 'Paystack', protocol: 'rest', access: 'write' }],
        database: { engine: 'postgres', migrations: true },
      }),
      registry,
    );
    expect(review.valid).toBe(true);
  });

  it('marks a planned stack as valid but not buildable', () => {
    const review = validateProjectSpecification(
      { name: 'Ledger', projectKind: 'backend', backend: 'django' },
      registry,
    );
    expect(review.valid).toBe(true);
    expect(review.supportLevel).toBe('planned');
    expect(review.unsupported.map((entry) => entry.id)).toEqual(['django']);
    expect(review.notes.join(' ')).toMatch(/not buildable yet/);
  });

  it('can demand scaffold support and then fails a planned stack', () => {
    const review = validateProjectSpecification(
      { name: 'Ledger', projectKind: 'backend', backend: 'django' },
      registry,
      { requireScaffold: true },
    );
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toContain('unsupported-technology');
  });

  it('reports the lowest support level across a mixed stack', () => {
    const review = validateProjectSpecification(
      { name: 'Mixed', projectKind: 'fullstack', frontend: 'react', backend: 'spring-boot' },
      registry,
    );
    expect(review.supportLevel).toBe('planned');
  });

  it('rejects an oversized specification', () => {
    const review = validateProjectSpecification(
      webSpec({ description: 'x'.repeat(40_000) }),
      registry,
    );
    expect(review.valid).toBe(false);
  });

  it('throws a typed error for an invalid specification', () => {
    expect(() => assertValidSpecification({ name: '' }, registry)).toThrow(AppBuilderError);
  });
});

describe('requested stack versus detected stack', () => {
  const detection: StackDetection = {
    projects: [
      {
        id: 'react',
        name: 'React',
        kind: 'framework',
        layer: 'frontend',
        confidence: 0.9,
        supportLevel: 'scaffold',
        evidence: [],
      },
    ],
    languages: [],
    frameworks: [],
    unrecognisedFiles: 0,
    unknownLanguages: [],
    notes: [],
  };

  it('is consistent when the requested framework is present', () => {
    const comparison = compareRequestedStack(
      { name: 'A', description: '', projectKind: 'web', frontend: 'react' },
      detection,
      registry,
    );
    expect(comparison.consistent).toBe(true);
  });

  it('reports a missing technology without substituting one', () => {
    const comparison = compareRequestedStack(
      { name: 'A', description: '', projectKind: 'web', frontend: 'vue' },
      detection,
      registry,
    );
    expect(comparison.consistent).toBe(false);
    expect(comparison.missing).toEqual(['vue']);
    expect(comparison.notes.join(' ')).toMatch(/Nothing was substituted/);
  });

  it('reports technologies the specification does not mention', () => {
    const comparison = compareRequestedStack(
      { name: 'A', description: '', projectKind: 'backend', backend: 'node-fastify' },
      { ...detection, languages: [{ ...detection.projects[0]!, id: 'react', kind: 'language' }] },
      registry,
    );
    expect(comparison.missing).toContain('node-fastify');
  });
});

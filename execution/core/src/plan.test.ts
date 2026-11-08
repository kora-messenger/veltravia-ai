/**
 * Planning: what the Primary Agent is allowed to conclude from a request and a
 * project, and what it must refuse to conclude.
 */

import { describe, expect, it } from 'vitest';

import { buildPlan, canRunTogether, inferScope, readyKeys, revisePlan } from './plan.js';
import type { ExecutionRequest, ProjectFacts } from './types.js';

const at = '2026-11-08T06:00:00.000Z';

function request(text: string, overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    text,
    projectId: 'prj_1',
    workspaceId: 'ws_1',
    requiresApproval: false,
    approvalReasons: [],
    receivedAt: at,
    ...overrides,
  };
}

function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    files: ['apps/web/src/App.tsx', 'apps/api/src/server.ts', 'package.json', 'README.md'],
    languages: ['typescript'],
    frameworks: ['react', 'fastify'],
    hasPackageJson: true,
    hasTests: true,
    hasDocs: true,
    revision: 'rev_7',
    unknown: [],
    ...overrides,
  };
}

describe('plan construction', () => {
  it('always understands, does the work, proves it and records it', () => {
    const plan = buildPlan({
      request: request('Add a settings screen to the app'),
      facts: facts(),
      createdAt: at,
    });
    const keys = plan.tasks.map((task) => task.key);
    expect(keys[0]).toBe('understand');
    expect(keys).toContain('verify');
    expect(keys[keys.length - 1]).toBe('document');
    expect(plan.version).toBe(1);
    expect(plan.revisionReason).toBeNull();
  });

  it('turns the request into implementation work by kind, not by wishful thinking', () => {
    const plan = buildPlan({
      request: request('Build the profile page and its API endpoint with a database migration'),
      facts: facts(),
      createdAt: at,
    });
    const kinds = plan.tasks.map((task) => task.kind);
    expect(kinds).toContain('frontend');
    expect(kinds).toContain('backend');
    expect(kinds).toContain('database');
    expect(kinds).toContain('testing');
  });

  it('keeps implementation work independent and proof work sequential', () => {
    const plan = buildPlan({
      request: request('Add the settings page and the settings endpoint'),
      facts: facts(),
      createdAt: at,
    });
    const frontend = plan.tasks.find((task) => task.kind === 'frontend');
    const backend = plan.tasks.find((task) => task.kind === 'backend');
    const verify = plan.tasks.find((task) => task.key === 'verify');
    expect(frontend?.phase).toBe('independent');
    expect(backend?.phase).toBe('independent');
    expect(verify?.dependsOn).toContain('frontend');
    expect(verify?.phase).toBe('sequential');
  });

  it('records what the inspector could not determine instead of guessing', () => {
    const plan = buildPlan({
      request: request('Add a settings screen'),
      facts: facts({
        hasPackageJson: false,
        hasTests: false,
        revision: null,
        unknown: ['build tool', 'test runner'],
      }),
      createdAt: at,
    });
    const inspection = plan.inspection.join(' ');
    expect(inspection).toMatch(/No package\.json/);
    expect(inspection).toMatch(/Could not determine: build tool/);
    expect(plan.risks.join(' ')).toMatch(/revision could not be read/);
  });

  it('marks a request that needs a decision instead of running it', () => {
    const plan = buildPlan({
      request: request('Deploy the new billing page to production and delete the old data'),
      facts: facts(),
      createdAt: at,
    });
    expect(plan.restrictions.join(' ')).toMatch(/Owner approval required/);
    const gated = plan.tasks.filter((task) => task.approval !== null);
    expect(gated.length).toBeGreaterThan(0);
  });

  it('scopes each task to directories the project actually has', () => {
    const plan = buildPlan({
      request: request('Add the settings page and the settings endpoint'),
      facts: facts(),
      createdAt: at,
    });
    const frontend = plan.tasks.find((task) => task.kind === 'frontend');
    const backend = plan.tasks.find((task) => task.kind === 'backend');
    expect(frontend?.scope).toContain('apps/web/src');
    expect(backend?.scope).toContain('apps/api/src');
    expect(frontend?.exclusions).toContain('.env');
  });

  it('falls back to src when the project has no recognised layout', () => {
    expect(inferScope(facts({ files: ['main.rs'] }), 'backend')).toEqual(['src']);
  });

  it('never lets two tasks in the same directory be called parallel-safe', () => {
    const plan = buildPlan({
      request: request('Add the settings page and fix the settings bug'),
      facts: facts({ files: ['src/App.tsx'] }),
      createdAt: at,
    });
    const [first, second] = plan.tasks.filter((task) => task.phase === 'independent');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(canRunTogether(first!, second!)).toBe(false);
  });
});

describe('revisions and readiness', () => {
  it('keeps the plan identity and states why it changed', () => {
    const plan = buildPlan({
      request: request('Add the settings page'),
      facts: facts(),
      createdAt: at,
    });
    const revised = revisePlan({
      plan,
      reason: 'Verification showed the settings loader was missing',
      change: {},
      createdAt: '2026-11-08T07:00:00.000Z',
    });
    expect(revised.version).toBe(2);
    expect(revised.revisionReason).toBe('Verification showed the settings loader was missing');
    expect(revised.tasks.length).toBe(plan.tasks.length);
  });

  it('does not quietly rewrite a task that already started', () => {
    const plan = buildPlan({
      request: request('Add the settings page'),
      facts: facts(),
      createdAt: at,
    });
    const started = {
      ...plan,
      tasks: plan.tasks.map((task) =>
        task.key === 'understand' ? { ...task, taskId: 'task_1' } : task,
      ),
    };
    const revised = revisePlan({
      plan: started,
      reason: 'The first pass found the wrong entry point',
      change: { remove: ['understand'] },
      createdAt: '2026-11-08T07:00:00.000Z',
    });
    expect(revised.tasks.find((task) => task.key === 'understand')?.taskId).toBe('task_1');
  });

  it('reports only tasks whose dependencies have finished', () => {
    const plan = buildPlan({
      request: request('Add the settings page and the settings endpoint'),
      facts: facts(),
      createdAt: at,
    });
    const withTasks = {
      ...plan,
      tasks: plan.tasks.map((task, index) => ({ ...task, taskId: `task_${index}` })),
    };
    // 'understand' has no dependencies, so it is runnable immediately.
    expect(readyKeys(withTasks, new Set())).toEqual(['understand']);
    expect(readyKeys(withTasks, new Set(['understand']))).toEqual(['frontend', 'backend']);
    expect(readyKeys(withTasks, new Set(['understand', 'frontend', 'backend']))).toEqual([
      'verify',
    ]);
  });
});

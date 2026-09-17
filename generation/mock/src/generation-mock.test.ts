import { describe, expect, it } from 'vitest';

import {
  createDecliningRepairSource,
  createDeterministicPlanner,
  createScriptedRepairSource,
} from './index.js';

describe('DeterministicPlanner', () => {
  const planner = createDeterministicPlanner({
    now: () => new Date('2026-09-17T08:00:00.000Z'),
  });

  it('produces the same spec and plan for the same idea', async () => {
    const idea =
      'Build me a task management web app with accounts, projects, tasks, and a dashboard';
    const first = await planner.plan(idea);
    const second = await planner.plan(idea);
    expect(first.spec).toEqual(second.spec);
    expect(first.plan).toEqual(second.plan);
  });

  it('derives a web application with template files for a web idea', async () => {
    const { spec, plan } = await planner.plan(
      'Build a task management web app with projects and a dashboard',
    );
    expect(spec.appType).toBe('web');
    expect(plan.templateId).toBe('web-react');
    expect(spec.name).not.toMatch(/^(build|create|make)$/i);
    expect(plan.filesToCreate.map((file) => file.path)).toContain('src/App.tsx');
    expect(plan.risk.destructiveActions).toEqual([]);
    expect(plan.dependencies.some((dependency) => dependency.name === 'react')).toBe(true);
  });

  it('derives a fullstack application for a fullstack idea', async () => {
    const { spec, plan } = await planner.plan(
      'Create a full-stack web app with a dashboard and an api backend',
    );
    expect(spec.appType).toBe('fullstack');
    expect(plan.templateId).toBe('fullstack-react-fastify');
    expect(plan.filesToCreate.map((file) => file.path)).toContain('server/index.ts');
  });

  it('plans only structured, allowlisted commands', async () => {
    const { plan } = await planner.plan('Build a task web app with settings');
    for (const command of plan.commands) {
      expect(['node', 'npm', 'npx', 'python', 'pip']).toContain(command.command);
      expect(Array.isArray(command.arguments)).toBe(true);
      expect(typeof command.purpose).toBe('string');
    }
  });

  it('carries no credentials, tokens, or secret-shaped material', async () => {
    const { spec, plan } = await planner.plan('Build a web app with accounts and settings');
    const dump = JSON.stringify({ spec, plan });
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
    expect(dump).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});

describe('ScriptedRepairSource', () => {
  it('returns proposals in order and then declines deterministically', async () => {
    const source = createScriptedRepairSource([
      { description: 'first fix', filesToWrite: [{ path: 'a.txt', content: 'a' }] },
      { description: 'second fix', filesToWrite: [{ path: 'b.txt', content: 'b' }] },
    ]);
    const context = {
      runId: 'r',
      attempt: 1,
      spec: null as never,
      plan: null as never,
      failures: [],
      untrustedFiles: [],
    };
    expect((await source.proposeFixes(context)).description).toBe('first fix');
    expect((await source.proposeFixes(context)).description).toBe('second fix');
    const declined = await source.proposeFixes(context);
    expect(declined.filesToWrite).toEqual([]);
  });
});

describe('DecliningRepairSource', () => {
  it('always proposes nothing', async () => {
    const source = createDecliningRepairSource();
    const proposal = await source.proposeFixes({
      runId: 'r',
      attempt: 1,
      spec: null as never,
      plan: null as never,
      failures: ['validation failed'],
      untrustedFiles: [],
    });
    expect(proposal.filesToWrite).toEqual([]);
    expect(proposal.description.length).toBeGreaterThan(0);
  });
});

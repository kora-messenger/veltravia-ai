import { describe, expect, it } from 'vitest';

import { AppBuilderError } from '../errors/index.js';
import { LanguageFrameworkRegistry } from '../registry/index.js';
import { AppBuilderManager, deriveDirectories } from './index.js';
import type { AppBuilderPorts, EnsureProjectInput } from '../ports/index.js';

interface FakeState {
  readonly projects: Map<string, { ownerRef: string; workspaceId: string }>;
  readonly files: Map<string, Map<string, string>>;
  readonly directories: Map<string, Set<string>>;
}

/** In-memory project port: proves the manager never writes by itself. */
function createPorts(): { ports: AppBuilderPorts; state: FakeState; calls: string[] } {
  const state: FakeState = { projects: new Map(), files: new Map(), directories: new Map() };
  const calls: string[] = [];
  let counter = 0;

  const ports: AppBuilderPorts = {
    projects: {
      async ensureProject(input: EnsureProjectInput) {
        counter += 1;
        calls.push(`ensureProject:${input.projectKind}`);
        const projectId = `proj_${counter}`;
        const workspaceId = `ws_${counter}`;
        state.projects.set(projectId, { ownerRef: input.ownerRef, workspaceId });
        state.files.set(workspaceId, new Map());
        state.directories.set(workspaceId, new Set());
        return { projectId, workspaceId };
      },
      async createDirectory(workspaceId, path) {
        calls.push(`mkdir:${path}`);
        state.directories.get(workspaceId)?.add(path);
      },
      async createFile(workspaceId, path, content) {
        calls.push(`write:${path}`);
        state.files.get(workspaceId)?.set(path, content);
      },
      async listFilePaths(workspaceId) {
        return [...(state.files.get(workspaceId)?.keys() ?? [])];
      },
      async readFileText(workspaceId, path) {
        return state.files.get(workspaceId)?.get(path);
      },
      async workspaceBelongsToProject(workspaceId, projectId) {
        return state.projects.get(projectId)?.workspaceId === workspaceId;
      },
    },
    sandbox: {
      available: false,
      reason: 'The sandbox engine is simulated in this release.',
      async run() {
        return { exitCode: null, output: '', real: false };
      },
    },
    codingAgent: {
      async startSession(request) {
        calls.push(`coding:${request.workspaceId}`);
        return { runId: 'run_1', status: 'queued' };
      },
    },
    preview: {
      async request() {
        return {
          available: false,
          mode: 'none',
          url: null,
          reason: 'No runtime is started by the builder in this release.',
        };
      },
    },
    deployment: {
      available: false,
      reason: 'No deployment provider is enabled in this release.',
      async deploy() {
        return { started: false, reason: 'No deployment provider is enabled in this release.' };
      },
    },
  };

  return { ports, state, calls };
}

function createManager(portsOverride?: AppBuilderPorts) {
  let counter = 0;
  const registry = new LanguageFrameworkRegistry();
  const ports = portsOverride ?? createPorts().ports;
  const manager = new AppBuilderManager({
    registry,
    ports,
    now: () => '2026-10-31T12:00:00.000Z',
    generateId: () => {
      counter += 1;
      return `plan_${counter}`;
    },
  });
  return { manager, registry, ports };
}

const webSpec = {
  name: 'Invoice Desk',
  description: 'Small invoicing app.',
  projectKind: 'web',
  frontend: 'react',
};

describe('app builder manager', () => {
  it('creates a plan without writing anything', () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });

    expect(plan.status).toBe('planned');
    expect(ports.calls).toHaveLength(0);
    expect(plan.files.length).toBeGreaterThan(0);
  });

  it('keeps plans private to their owner', () => {
    const { manager } = createManager();
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });

    expect(manager.listPlans('owner-b')).toHaveLength(0);
    expect(() => manager.getPlan('owner-b', plan.id)).toThrow(AppBuilderError);
    try {
      manager.getPlan('owner-b', plan.id);
    } catch (error) {
      expect((error as AppBuilderError).code).toBe('APP_BUILDER_PLAN_NOT_FOUND');
    }
  });

  it('materializes a plan into a real project through the port', async () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });

    const result = await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    expect(result.projectId).toBe('proj_1');
    expect(result.createdFiles).toContain('src/App.tsx');
    expect(ports.calls).toContain('mkdir:src');
    expect(ports.state.files.get(result.workspaceId)?.get('package.json')).toContain('"react"');
    expect(manager.getPlan('owner-a', plan.id).status).toBe('materialized');
  });

  it('creates parent directories before the files that need them', async () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    const mkdirIndex = ports.calls.indexOf('mkdir:src');
    const writeIndex = ports.calls.indexOf('write:src/App.tsx');
    expect(mkdirIndex).toBeGreaterThan(-1);
    expect(mkdirIndex).toBeLessThan(writeIndex);
  });

  it('refuses to materialize the same plan twice', async () => {
    const { manager } = createManager();
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    await expect(manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id })).rejects.toThrow(
      /already turned into a project/,
    );
  });

  it('reports which files exist when a write fails halfway', async () => {
    const ports = createPorts();
    let writes = 0;
    const flaky: AppBuilderPorts = {
      ...ports.ports,
      projects: {
        ...ports.ports.projects,
        async createFile(workspaceId, path, content) {
          writes += 1;
          if (writes > 2) throw new Error('disk full');
          return ports.ports.projects.createFile(workspaceId, path, content);
        },
      },
    };
    const { manager } = createManager(flaky);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });

    await expect(manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id })).rejects.toThrow(
      /stopped after 2 of/,
    );
  });

  it('refuses to scaffold an unsupported stack', () => {
    const { manager } = createManager();
    expect(() =>
      manager.createPlan({
        ownerRef: 'owner-a',
        specification: { name: 'Spring', projectKind: 'backend', backend: 'spring-boot' },
      }),
    ).toThrow(/cannot scaffold/);
  });

  it('reviews a specification without creating a plan', () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const review = manager.reviewSpecification({ name: '', projectKind: 'web' });
    expect(review.valid).toBe(false);
    expect(manager.listPlans('owner-a')).toHaveLength(0);
    expect(ports.calls).toHaveLength(0);
  });

  it('detects the stack of a workspace through the project port', async () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    const result = await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    const detection = await manager.detectWorkspace({ workspaceId: result.workspaceId });
    expect(detection.frameworks.map((framework) => framework.id)).toContain('react');
  });

  it('refuses to detect a workspace that is not in the named project', async () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    const result = await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    await expect(
      manager.detectWorkspace({ workspaceId: result.workspaceId, projectId: 'proj_unknown' }),
    ).rejects.toThrow(/not part of the project/);
  });

  it('reports the build honestly as unavailable', async () => {
    const { manager } = createManager();
    const status = await manager.buildStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/simulated/);
  });

  it('delegates coding work to the existing agent instead of looping here', async () => {
    const ports = createPorts();
    const { manager } = createManager(ports.ports);
    const result = await manager.startCodingSession({
      ownerRef: 'owner-a',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      instruction: 'Add a health route.',
    });
    expect(result.runId).toBe('run_1');
    expect(ports.calls).toContain('coding:ws_1');
  });

  it('rejects an empty coding instruction', async () => {
    const { manager } = createManager();
    await expect(
      manager.startCodingSession({
        ownerRef: 'owner-a',
        projectId: 'proj_1',
        workspaceId: 'ws_1',
        instruction: '   ',
      }),
    ).rejects.toThrow(AppBuilderError);
  });

  it('keeps an audit trail per owner', async () => {
    const { manager } = createManager();
    const plan = manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    await manager.materializePlan({ ownerRef: 'owner-a', planId: plan.id });

    const events = manager.audit('owner-a');
    expect(events.map((event) => event.action)).toEqual(['plan.create', 'plan.materialize']);
    expect(manager.audit('owner-b')).toHaveLength(0);
  });

  it('publishes capabilities that do not overclaim', () => {
    const { manager } = createManager();
    const capabilities = manager.capabilities();
    expect(capabilities.notSupported.join(' ')).toMatch(/real build or test/);
    expect(capabilities.partial.join(' ')).toMatch(/never executed/);
    expect(capabilities.milestones.some((milestone) => milestone.state === 'planned')).toBe(true);
  });

  it('limits how many plans one owner can hold', () => {
    const { manager } = createManager();
    for (let index = 0; index < 50; index += 1) {
      manager.createPlan({ ownerRef: 'owner-a', specification: webSpec });
    }
    expect(() => manager.createPlan({ ownerRef: 'owner-a', specification: webSpec })).toThrow(
      /reached the number of plans/,
    );
  });
});

describe('deriveDirectories', () => {
  it('returns parents before children and never the root', () => {
    expect(deriveDirectories(['src/app/main.ts', 'docs/readme.md', 'index.html'])).toEqual([
      'docs',
      'src',
      'src/app',
    ]);
  });
});

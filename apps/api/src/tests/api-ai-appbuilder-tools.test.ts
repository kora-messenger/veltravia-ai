import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { createAppBuilderManager } from '../app-builder-service.js';
import { createToolManager } from '../tools.js';

/**
 * The assistant's App Builder tools. Real project engine, real App Builder
 * manager, real tool manager: ownership, grants and the "read-only half only"
 * boundary are all exercised end to end.
 */
const NOW = () => new Date('2026-11-04T10:00:00.000Z');

async function setup(ownerRef: string) {
  const projects = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projects.projects.createProject({
    name: 'tool-project',
    description: 'seeded for the App Builder tool tests',
    projectType: 'web',
    ownerRef,
  });
  const workspace = await projects.workspaces.createWorkspace(project.id, { name: 'main' });
  await projects.files.createFile(workspace.id, {
    path: 'package.json',
    content: JSON.stringify({
      name: 'demo',
      dependencies: { react: '^18.0.0', vite: '^5.0.0' },
      scripts: { dev: 'vite' },
    }),
  });
  const manager = createAppBuilderManager({
    projectEngine: projects,
    codingAgent: {} as never,
  });
  const tools = createToolManager(
    NOW,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ownerRef,
    undefined,
    { manager, projects },
  );
  const rebind = (other: string) =>
    createToolManager(
      NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      other,
      undefined,
      { manager, projects },
    );
  return { tools, project, workspace, rebind, projects };
}

async function sameProjectsAs(
  owned: Awaited<ReturnType<typeof setup>>,
  otherOwner: string,
): Promise<ReturnType<typeof createToolManager>> {
  return owned.rebind(otherOwner);
}

/** Runs a tool that needs approval: it pauses, a person decides, it resumes. */
async function withApproval(
  tools: ReturnType<typeof createToolManager>,
  id: string,
  input: Record<string, unknown>,
  decision: 'approved' | 'rejected' = 'approved',
) {
  const paused = await tools.invoke(id, input, { requester: 'test' });
  expect(paused.status, `${id} must pause for approval first`).toBe('awaiting_confirmation');
  const confirmationId = (paused as { confirmationId?: string }).confirmationId as string;
  expect(confirmationId).toBeTruthy();
  tools.confirm(confirmationId, decision);
  return tools.invoke(id, input, { requester: 'test', confirmationId });
}

const call = (
  tools: ReturnType<typeof createToolManager>,
  id: string,
  input: Record<string, unknown>,
) => tools.invoke(id, input, { requester: 'test' });

describe('App Builder tools for the assistant', () => {
  it('registers the reading tools and the acting tools, and nothing else', async () => {
    const { tools } = await setup('owner-a');
    const ids = tools
      .list()
      .map((tool) => tool.id)
      .filter((id) => id.startsWith('appbuilder.'));
    expect(ids.sort()).toEqual([
      'appbuilder.capabilities',
      'appbuilder.check_spec',
      'appbuilder.create_plan',
      'appbuilder.create_project_from_plan',
      'appbuilder.deploy',
      'appbuilder.detect_stack',
      'appbuilder.request_preview',
      'appbuilder.run_build',
      'appbuilder.start_coding_session',
      'appbuilder.technology',
    ]);
  });

  it('asks a person before anything that changes a project, builds or deploys', async () => {
    const { tools } = await setup('owner-a');
    const risky = [
      'appbuilder.create_project_from_plan',
      'appbuilder.start_coding_session',
      'appbuilder.run_build',
      'appbuilder.request_preview',
      'appbuilder.deploy',
    ];
    for (const id of risky) {
      const definition = tools.list().find((tool) => tool.id === id);
      expect(definition?.requiresConfirmation, `${id} must require approval`).toBe(true);
    }
    for (const id of ['appbuilder.capabilities', 'appbuilder.create_plan']) {
      const definition = tools.list().find((tool) => tool.id === id);
      expect(definition?.requiresConfirmation, `${id} only reads or plans`).toBe(false);
    }
  });

  it('reports what the builder supports', async () => {
    const { tools } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.capabilities', {});
    expect(result.status).toBe('success');
    expect(JSON.stringify(result)).toContain('registryVersion');
  });

  it('lists which technologies are ready to scaffold and which are only planned', async () => {
    const { tools } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.capabilities', {});
    expect(result.status).toBe('success');
    const output = result.output as { planned: string[]; scaffoldReady: string[] };
    // These come from the catalog's support levels. They used to be read from a
    // field capabilities() does not have, so both lists were always empty.
    expect(output.scaffoldReady.length).toBeGreaterThan(0);
    expect(output.planned.length).toBeGreaterThan(0);
    expect(output.planned.some((id) => output.scaffoldReady.includes(id))).toBe(false);

    const onlyPlanned = await call(tools, 'appbuilder.capabilities', { plannedOnly: true });
    const narrow = onlyPlanned.output as { planned: string[]; supported: string[] };
    expect(narrow.planned).toEqual(output.planned);
    expect(narrow.supported).toEqual([]);
  });

  it('detects the stack of the owner’s own workspace', async () => {
    const { tools, project, workspace } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.detect_stack', {
      projectId: project.id,
      workspaceId: workspace.id,
    });
    expect(result.status).toBe('success');
    expect(JSON.stringify(result).toLowerCase()).toContain('react');
  });

  it('refuses a project that belongs to someone else, and says nothing about it', async () => {
    const owned = await setup('owner-a');
    // A second tool manager, bound to a different owner, over the SAME projects.
    const intruder = await sameProjectsAs(owned, 'owner-b');

    const refused = await call(intruder, 'appbuilder.detect_stack', {
      projectId: owned.project.id,
      workspaceId: owned.workspace.id,
    });
    expect(refused.status).not.toBe('success');

    // A project id that does not exist must look the same as one that is not yours.
    const missing = await call(intruder, 'appbuilder.detect_stack', {
      projectId: 'prj_does_not_exist',
      workspaceId: owned.workspace.id,
    });
    expect(missing.status).not.toBe('success');
    expect(JSON.stringify(refused)).not.toContain('tool-project');
    expect(JSON.stringify(refused)).not.toContain('package.json');
  });

  it('refuses a workspace that is not part of the named project', async () => {
    const { tools, project } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.detect_stack', {
      projectId: project.id,
      workspaceId: 'ws_from_somewhere_else',
    });
    expect(result.status).not.toBe('success');
  });

  it('checks a specification without saving anything', async () => {
    const { tools } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.check_spec', {
      specification: { name: 'x', projectKind: 'web', frontend: 'react' },
    });
    expect(result.status).toBe('success');
    expect(result.output).toMatchObject({ valid: true, supportLevel: 'scaffold' });
  });

  it('rejects an invented technology id', async () => {
    const { tools } = await setup('owner-a');
    const result = await call(tools, 'appbuilder.technology', { technologyId: 'not-a-real-tech' });
    expect(result.status).not.toBe('success');
  });
});

/** A spec the catalog can scaffold, so a plan has real files in it. */
const SPEC = { name: 'planned-app', projectKind: 'web', frontend: 'react' };

describe('App Builder tools that act', () => {
  const planFor = async (tools: ReturnType<typeof createToolManager>) => {
    const planned = await call(tools, 'appbuilder.create_plan', { specification: SPEC });
    return (planned.output as { plan: { id: string } }).plan.id;
  };

  it('plans without writing anything, and never returns file contents', async () => {
    const { tools, projects } = await setup('owner-a');
    const before = (await projects.projects.listProjects()).length;
    const result = await call(tools, 'appbuilder.create_plan', { specification: SPEC });
    expect(result.status).toBe('success');
    const plan = (result.output as { plan: { fileCount: number; files: unknown[] } }).plan;
    expect(plan.fileCount).toBeGreaterThan(0);
    expect(plan.files.length).toBeGreaterThan(0);
    // Paths and descriptions only: contents would flood the model and add nothing.
    expect(JSON.stringify(result.output)).not.toContain('"content"');
    expect((await projects.projects.listProjects()).length).toBe(before);
  });

  it('pauses before writing a project, and writes only after a person approves', async () => {
    const { tools, projects } = await setup('owner-a');
    const planId = await planFor(tools);
    const before = (await projects.projects.listProjects()).length;

    const paused = await call(tools, 'appbuilder.create_project_from_plan', { planId });
    expect(paused.status).toBe('awaiting_confirmation');
    // Nothing has been written while the question is open.
    expect((await projects.projects.listProjects()).length).toBe(before);

    const done = await withApproval(tools, 'appbuilder.create_project_from_plan', { planId });
    expect(done.status).toBe('success');
    const out = done.output as { filesCreated: number };
    expect(out.filesCreated).toBeGreaterThan(0);
    expect((await projects.projects.listProjects()).length).toBe(before + 1);
  });

  it('writes real files into the new project, including when no description is given', async () => {
    // A specification may omit the description. The project engine insists on a
    // string, so this used to fail with a vague "project could not be created".
    const { tools, projects } = await setup('owner-a');
    const planId = await planFor(tools);
    const done = await withApproval(tools, 'appbuilder.create_project_from_plan', { planId });
    expect(done.status).toBe('success');
    const out = done.output as {
      workspaceId: string;
      filesCreated: number;
      createdFiles: string[];
    };
    const written = await projects.files.listAll(out.workspaceId);
    const paths = written.filter((node) => node.type === 'file').map((node) => node.path);
    expect(paths.length).toBe(out.filesCreated);
    expect(paths).toContain('package.json');
  });

  it('writes nothing when the person says no', async () => {
    const { tools, projects } = await setup('owner-a');
    const planId = await planFor(tools);
    const before = (await projects.projects.listProjects()).length;
    const refused = await withApproval(
      tools,
      'appbuilder.create_project_from_plan',
      { planId },
      'rejected',
    );
    expect(refused.status).not.toBe('success');
    expect((await projects.projects.listProjects()).length).toBe(before);
  });

  it('will not write the same plan twice', async () => {
    const { tools } = await setup('owner-a');
    const planId = await planFor(tools);
    expect(
      (await withApproval(tools, 'appbuilder.create_project_from_plan', { planId })).status,
    ).toBe('success');
    expect(
      (await withApproval(tools, 'appbuilder.create_project_from_plan', { planId })).status,
    ).not.toBe('success');
  });

  it('keeps one owner away from another owner’s plan', async () => {
    const owned = await setup('owner-a');
    const planId = await planFor(owned.tools);
    const intruder = owned.rebind('owner-b');
    const before = (await owned.projects.projects.listProjects()).length;
    // Even with a person approving, the plan is not theirs to write.
    const result = await withApproval(intruder, 'appbuilder.create_project_from_plan', { planId });
    expect(result.status).not.toBe('success');
    expect((await owned.projects.projects.listProjects()).length).toBe(before);
    // And the real owner can still use it.
    const mine = await withApproval(owned.tools, 'appbuilder.create_project_from_plan', {
      planId,
    });
    expect(mine.status).toBe('success');
  });

  it('says plainly that no build ran, and never claims one did', async () => {
    const { tools } = await setup('owner-a');
    const planId = await planFor(tools);
    const done = await withApproval(tools, 'appbuilder.run_build', { planId });
    expect(done.status).toBe('success');
    expect(done.output).toMatchObject({ ran: false });
    expect((done.output as { reason: string }).reason.length).toBeGreaterThan(5);
  });

  it('says plainly that nothing was deployed, and never claims one began', async () => {
    const { tools, project } = await setup('owner-a');
    const done = await withApproval(tools, 'appbuilder.deploy', {
      projectId: project.id,
      target: 'staging',
    });
    expect(done.status).toBe('success');
    expect(done.output).toMatchObject({ started: false });
    expect((done.output as { reason: string }).reason).toMatch(/no deployment provider/i);
  });

  it('refuses to deploy a project that belongs to someone else', async () => {
    const owned = await setup('owner-a');
    const intruder = owned.rebind('owner-b');
    const result = await withApproval(intruder, 'appbuilder.deploy', {
      projectId: owned.project.id,
      target: 'staging',
    });
    expect(result.status).not.toBe('success');
    expect(JSON.stringify(result)).not.toContain('tool-project');
  });

  it('refuses to preview or hand work to the agent for someone else’s project', async () => {
    const owned = await setup('owner-a');
    const intruder = owned.rebind('owner-b');
    const base = { projectId: owned.project.id, workspaceId: owned.workspace.id };
    expect((await withApproval(intruder, 'appbuilder.request_preview', base)).status).not.toBe(
      'success',
    );
    expect(
      (
        await withApproval(intruder, 'appbuilder.start_coding_session', {
          ...base,
          instruction: 'Add a login page.',
        })
      ).status,
    ).not.toBe('success');
  });
});

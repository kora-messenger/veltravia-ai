import { describe, expect, it } from 'vitest';
import { buildTestEngine } from './project-manager.test.js';

const VALID_INPUT = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile' as const,
  ownerRef: 'user-1',
};

async function buildProject() {
  const engine = buildTestEngine();
  const project = await engine.projects.createProject(VALID_INPUT);
  return { engine, project };
}

describe('Project context', () => {
  it('creates an empty context on first access', async () => {
    const { engine, project } = await buildProject();
    const context = await engine.projects.getProjectContext(project.id);
    expect(context.goals).toEqual([]);
    expect(context.revision).toBe(1);
  });

  it('updates categories with revision checks', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectContext(project.id);
    const updated = await engine.projects.updateProjectContext(
      project.id,
      {
        goals: ['Ship the trading companion'],
        technologyPreferences: ['React Native over native modules'],
        architectureNotes: ['Screens own no business logic'],
        buildPreferences: ['Strict TypeScript, no any'],
        userInstructions: ['Prefer violet-to-cyan gradient accents'],
        decisions: [
          {
            summary: 'SQLite for offline cache',
            rationale: 'Deterministic tests',
            decidedAt: '2026-09-13',
          },
        ],
      },
      first.revision,
    );
    expect(updated.goals).toEqual(['Ship the trading companion']);
    expect(updated.decisions[0]?.summary).toBe('SQLite for offline cache');
    expect(updated.revision).toBe(2);
  });

  it('retrieves the stored context', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectContext(project.id);
    await engine.projects.updateProjectContext(
      project.id,
      { goals: ['remembered'] },
      first.revision,
    );
    const read = await engine.projects.getProjectContext(project.id);
    expect(read.goals).toEqual(['remembered']);
  });

  it('serializes safely (plain JSON, no class instances)', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectContext(project.id);
    await engine.projects.updateProjectContext(
      project.id,
      { goals: ['serializable'] },
      first.revision,
    );
    const read = await engine.projects.getProjectContext(project.id);
    expect(() => JSON.stringify(read)).not.toThrow();
    expect(JSON.parse(JSON.stringify(read)).goals).toEqual(['serializable']);
  });

  it('rejects unknown categories and invalid entries', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectContext(project.id);
    await expect(
      engine.projects.updateProjectContext(
        project.id,
        { secretSauce: ['x'] } as never,
        first.revision,
      ),
    ).rejects.toThrow(/unknown context category/);
    await expect(
      engine.projects.updateProjectContext(project.id, { goals: [42] as never }, first.revision),
    ).rejects.toThrow(/goals entries must be strings/);
  });

  it('rejects context writes on archived projects', async () => {
    const { engine, project } = await buildProject();
    await engine.projects.archiveProject(project.id);
    await expect(
      engine.projects.updateProjectContext(project.id, { goals: ['late'] }, 1),
    ).rejects.toThrow(/archived/);
  });
});

describe('Project configuration', () => {
  it('creates an empty config on first access', async () => {
    const { engine, project } = await buildProject();
    const config = await engine.projects.getProjectConfig(project.id);
    expect(config.entryPoints).toEqual([]);
    expect(config.revision).toBe(1);
  });

  it('patches safe metadata', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectConfig(project.id);
    const updated = await engine.projects.updateProjectConfig(
      project.id,
      {
        framework: 'react-native',
        language: 'typescript',
        runtime: 'node',
        packageManager: 'npm',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        lintCommand: 'npm run lint',
        entryPoints: ['src/main.tsx'],
      },
      first.revision,
    );
    expect(updated.framework).toBe('react-native');
    expect(updated.entryPoints).toEqual(['src/main.tsx']);
  });

  it('rejects secret-like fields and unknown fields', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectConfig(project.id);
    await expect(
      engine.projects.updateProjectConfig(
        project.id,
        { password: 'hunter2' } as never,
        first.revision,
      ),
    ).rejects.toThrow(/unknown configuration field/);
    // note: unknown fields are rejected before the secret scan - the schema
    // surface (API) also enforces additionalProperties: false.
    await expect(
      engine.projects.updateProjectConfig(
        project.id,
        { framework: 'x', apiKey: 'y' } as never,
        first.revision,
      ),
    ).rejects.toThrow(/unknown configuration field/);
  });

  it('rejects invalid entry points and empty values', async () => {
    const { engine, project } = await buildProject();
    const first = await engine.projects.getProjectConfig(project.id);
    await expect(
      engine.projects.updateProjectConfig(project.id, { entryPoints: [''] }, first.revision),
    ).rejects.toThrow(/entryPoints entries must be non-empty/);
    await expect(
      engine.projects.updateProjectConfig(project.id, { framework: '' }, first.revision),
    ).rejects.toThrow(/framework/);
  });
});

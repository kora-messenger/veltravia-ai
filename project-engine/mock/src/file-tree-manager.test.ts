import { describe, expect, it } from 'vitest';
import { buildTestEngine } from './project-manager.test.js';

const VALID_INPUT = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile' as const,
  ownerRef: 'user-1',
};

async function buildWorkspace() {
  const engine = buildTestEngine();
  const project = await engine.projects.createProject(VALID_INPUT);
  const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
  return { engine, project, workspace };
}

describe('FileTreeManager - files', () => {
  it('creates and reads a file at the workspace root', async () => {
    const { engine, workspace } = await buildWorkspace();
    const file = await engine.files.createFile(workspace.id, {
      path: 'package.json',
      content: '{"name":"app"}',
    });
    expect(file.type).toBe('file');
    expect(file.size).toBe(14); // byte length of '{"name":"app"}'
    const { content } = await engine.files.readFile(workspace.id, 'package.json');
    expect(content).toBe('{"name":"app"}');
  });

  it('creates files in nested directories', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'src');
    await engine.files.createDirectory(workspace.id, 'src/components');
    const file = await engine.files.createFile(workspace.id, {
      path: 'src/components/Button.tsx',
      content: 'export {}',
    });
    expect(file.path).toBe('src/components/Button.tsx');
    const children = await engine.files.listDirectory(workspace.id, 'src/components');
    expect(children.map((node) => node.path)).toEqual(['src/components/Button.tsx']);
  });

  it('updates a file with a valid expectedRevision', async () => {
    const { engine, workspace } = await buildWorkspace();
    const file = await engine.files.createFile(workspace.id, { path: 'README.md', content: 'v1' });
    const updated = await engine.files.updateFile(workspace.id, 'README.md', {
      content: 'v2',
      expectedRevision: file.revision,
    });
    expect(updated.revision).toBe(2);
    expect((await engine.files.readFile(workspace.id, 'README.md')).content).toBe('v2');
  });

  it('deletes a file but not a directory (and vice versa)', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createFile(workspace.id, { path: 'notes.txt', content: 'hi' });
    await engine.files.createDirectory(workspace.id, 'docs');
    await expect(engine.files.deleteFile(workspace.id, 'docs')).rejects.toThrow(
      /use deleteDirectory/,
    );
    await engine.files.deleteFile(workspace.id, 'notes.txt');
    await expect(engine.files.readFile(workspace.id, 'notes.txt')).rejects.toThrow(
      /No file tree node/,
    );
    // The file is gone entirely - deleting it as a directory is a not-found
    await expect(engine.files.deleteDirectory(workspace.id, 'notes.txt')).rejects.toThrow(
      /No file tree node/,
    );
  });
});

describe('FileTreeManager - directories', () => {
  it('rejects missing parents', async () => {
    const { engine, workspace } = await buildWorkspace();
    await expect(
      engine.files.createFile(workspace.id, { path: 'missing/dir/App.tsx', content: '' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects a file used as a parent directory', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createFile(workspace.id, { path: 'blocker.ts', content: '' });
    await expect(
      engine.files.createFile(workspace.id, { path: 'blocker.ts/inner.txt', content: '' }),
    ).rejects.toThrow(/not a directory/);
  });

  it('rejects duplicate paths and type conflicts', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createFile(workspace.id, { path: 'App.tsx', content: '' });
    await expect(
      engine.files.createFile(workspace.id, { path: 'App.tsx', content: '' }),
    ).rejects.toThrow(/already exists/);
    await expect(engine.files.createDirectory(workspace.id, 'App.tsx')).rejects.toThrow(
      /already exists/,
    );
  });

  it('rejects deleting a non-empty directory', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'src');
    await engine.files.createFile(workspace.id, { path: 'src/App.tsx', content: '' });
    await expect(engine.files.deleteDirectory(workspace.id, 'src')).rejects.toThrow(/not empty/);
    await engine.files.deleteFile(workspace.id, 'src/App.tsx');
    await engine.files.deleteDirectory(workspace.id, 'src');
    await expect(engine.files.listDirectory(workspace.id, 'src')).rejects.toThrow(
      /No file tree node/,
    );
    expect(await engine.files.listDirectory(workspace.id, '')).toEqual([]);
  });
});

describe('FileTreeManager - move / rename', () => {
  it('moves a file into an existing directory', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createFile(workspace.id, { path: 'App.tsx', content: 'x' });
    await engine.files.createDirectory(workspace.id, 'src');
    const moved = await engine.files.moveNode(workspace.id, {
      fromPath: 'App.tsx',
      toDirectory: 'src',
    });
    expect(moved.path).toBe('src/App.tsx');
    expect((await engine.files.readFile(workspace.id, 'src/App.tsx')).content).toBe('x');
  });

  it('rewrites subtree paths when moving a directory', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'old');
    await engine.files.createDirectory(workspace.id, 'old/nested');
    await engine.files.createFile(workspace.id, { path: 'old/a.txt', content: 'a' });
    await engine.files.createFile(workspace.id, { path: 'old/nested/b.txt', content: 'b' });
    await engine.files.renameNode(workspace.id, { path: 'old', newName: 'new' });
    const nodes = await engine.files.listAll(workspace.id);
    expect(nodes.map((node) => node.path)).toEqual([
      'new',
      'new/a.txt',
      'new/nested',
      'new/nested/b.txt',
    ]);
    // Contents survive the subtree rewrite
    expect((await engine.files.readFile(workspace.id, 'new/nested/b.txt')).content).toBe('b');
  });

  it('moves a directory into another directory, rewriting the subtree', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'src');
    await engine.files.createDirectory(workspace.id, 'legacy');
    await engine.files.createFile(workspace.id, { path: 'legacy/App.tsx', content: 'app' });
    const moved = await engine.files.moveNode(workspace.id, {
      fromPath: 'legacy',
      toDirectory: 'src',
    });
    expect(moved.path).toBe('src/legacy');
    expect((await engine.files.readFile(workspace.id, 'src/legacy/App.tsx')).content).toBe('app');
  });

  it('renames a node in place', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'src');
    await engine.files.createFile(workspace.id, { path: 'src/main.tsx', content: '' });
    const renamed = await engine.files.renameNode(workspace.id, {
      path: 'src/main.tsx',
      newName: 'index.tsx',
    });
    expect(renamed.path).toBe('src/index.tsx');
    await expect(engine.files.readFile(workspace.id, 'src/main.tsx')).rejects.toThrow(
      /No file tree node/,
    );
  });

  it('rejects moving a directory into its own subtree', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createDirectory(workspace.id, 'src');
    await engine.files.createDirectory(workspace.id, 'src/inner');
    await expect(
      engine.files.moveNode(workspace.id, { fromPath: 'src', toDirectory: 'src/inner' }),
    ).rejects.toThrow(/own subtree/);
  });

  it('rejects moves onto existing nodes and missing target parents', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.files.createFile(workspace.id, { path: 'a.txt', content: '' });
    await engine.files.createFile(workspace.id, { path: 'b.txt', content: '' });
    await expect(
      engine.files.moveNode(workspace.id, { fromPath: 'a.txt', toDirectory: '' }),
    ).rejects.toThrow(/already exists/); // b.txt occupies the same target name? no - target is a.txt itself... rename check below
    await expect(
      engine.files.moveNode(workspace.id, { fromPath: 'a.txt', toDirectory: 'nowhere' }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      engine.files.renameNode(workspace.id, { path: 'a.txt', newName: 'b.txt' }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('FileTreeManager - workspace state rules', () => {
  it('rejects mutations against locked workspaces', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.workspaces.lockWorkspace(workspace.id);
    await expect(
      engine.files.createFile(workspace.id, { path: 'x.txt', content: '' }),
    ).rejects.toThrow(/locked/);
    // Reads stay available while locked
    expect(await engine.files.listDirectory(workspace.id, '')).toEqual([]);
  });

  it('rejects mutations against archived workspaces', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.workspaces.archiveWorkspace(workspace.id);
    await expect(engine.files.createDirectory(workspace.id, 'src')).rejects.toThrow(/archived/);
  });

  it('rejects operations on unknown workspaces', async () => {
    const { engine } = await buildWorkspace();
    await expect(engine.files.createFile('ws-404', { path: 'x.txt', content: '' })).rejects.toThrow(
      /No workspace found/,
    );
  });

  it('bumps the workspace revision on file mutations', async () => {
    const { engine, workspace } = await buildWorkspace();
    expect(workspace.revision).toBe(1);
    await engine.files.createFile(workspace.id, { path: 'a.txt', content: '' });
    const after = await engine.workspaces.getWorkspace(workspace.id);
    expect(after.revision).toBe(2);
  });
});

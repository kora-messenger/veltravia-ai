import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';

import { ExportManager } from './manager.js';
import { EXPORT_LIMITS } from './types.js';
import { FakeProject } from './testing-fakes.js';
import { InMemoryArchiveStore } from './store.js';

const OWNER = 'owner-a';
const FAKE_KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';

/** Extract with a DIFFERENT library than the one that built the archive. */
function extract(bytes: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) return reject(error);
      const out = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function seeded(): FakeProject {
  const project = new FakeProject();
  project.write('package.json', '{\n  "name": "app",\n  "scripts": { "test": "vitest" }\n}\n');
  project.write('package-lock.json', '{"lockfileVersion":3}\n');
  project.write('README.md', '# My App\r\n\r\nTrailing spaces kept.  \r\n');
  project.write('src/index.ts', 'export const answer = 42;\n');
  project.write('src/ui/App.tsx', 'export const App = () => <div>hi</div>;\n');
  project.write('server/main.py', 'print("héllo ✓")\n');
  project.write('server/go.mod', 'module example.com/app\n');
  project.write('Dockerfile', 'FROM node:20\n');
  return project;
}

function manager(project: FakeProject, now = () => new Date('2026-11-05T10:00:00Z')) {
  const store = new InMemoryArchiveStore();
  return { manager: new ExportManager({ source: project, store, now }), store };
}

describe('a whole-project export', () => {
  it('produces a ZIP with every file, byte for byte, under one root folder', async () => {
    const project = seeded();
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('ready');
    expect(view.fileName).toBe('My-App.zip');
    expect(view.excluded).toEqual([]);

    const files = await extract(m.download(OWNER, view.exportId).bytes);
    expect([...files.keys()].sort()).toEqual([
      'My-App/Dockerfile',
      'My-App/README.md',
      'My-App/package-lock.json',
      'My-App/package.json',
      'My-App/server/go.mod',
      'My-App/server/main.py',
      'My-App/src/index.ts',
      'My-App/src/ui/App.tsx',
    ]);
    // Contents are exactly what was stored: CRLF, trailing spaces, unicode.
    expect(files.get('My-App/README.md')).toBe('# My App\r\n\r\nTrailing spaces kept.  \r\n');
    expect(files.get('My-App/server/main.py')).toBe('print("héllo ✓")\n');
    expect(files.get('My-App/package.json')).toBe(
      '{\n  "name": "app",\n  "scripts": { "test": "vitest" }\n}\n',
    );
  });

  it('records the revision it read, and a hash that matches the bytes', async () => {
    const project = seeded();
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.revision).toBe(await project.workspaceRevision());
    const { bytes, sha256 } = m.download(OWNER, view.exportId);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    expect(view.archiveHash).toBe(sha256);
    expect(view.totals.files).toBe(8);
  });

  it('is deterministic: the same revision gives the same archive hash', async () => {
    const project = seeded();
    const { manager: m } = manager(project);
    const a = await m.createExport(OWNER, { projectId: 'prj-1' });
    const b = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(a.exportId).not.toBe(b.exportId);
    expect(a.archiveHash).toBe(b.archiveHash);
  });

  it('does not modify the project', async () => {
    const project = seeded();
    const before = await project.workspaceRevision();
    const { manager: m } = manager(project);
    await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(await project.workspaceRevision()).toBe(before);
  });
});

describe('a selection export', () => {
  it('exports one directory with its nested files only', async () => {
    const { manager: m } = manager(seeded());
    const view = await m.createExport(OWNER, {
      projectId: 'prj-1',
      scope: 'selection',
      paths: ['src'],
    });
    const files = await extract(m.download(OWNER, view.exportId).bytes);
    expect([...files.keys()].sort()).toEqual(['My-App/src/index.ts', 'My-App/src/ui/App.tsx']);
  });

  it('exports individual files and several roots, keeping their folders', async () => {
    const { manager: m } = manager(seeded());
    const view = await m.createExport(OWNER, {
      projectId: 'prj-1',
      scope: 'selection',
      paths: ['package.json', 'server/main.py', 'src/ui'],
    });
    const files = await extract(m.download(OWNER, view.exportId).bytes);
    expect([...files.keys()].sort()).toEqual([
      'My-App/package.json',
      'My-App/server/main.py',
      'My-App/src/ui/App.tsx',
    ]);
  });

  it('does not duplicate a file named both directly and through its folder', async () => {
    const { manager: m } = manager(seeded());
    const view = await m.createExport(OWNER, {
      projectId: 'prj-1',
      scope: 'selection',
      paths: ['src', 'src/index.ts'],
    });
    expect(view.selection).toEqual(['src']);
    expect(view.totals.files).toBe(2);
  });

  it('refuses an empty selection and a selection of a path that does not exist', async () => {
    const { manager: m } = manager(seeded());
    await expect(
      m.createExport(OWNER, { projectId: 'prj-1', scope: 'selection', paths: [] }),
    ).rejects.toMatchObject({ code: 'EXPORT_SELECTION_EMPTY' });
    const view = await m.createExport(OWNER, {
      projectId: 'prj-1',
      scope: 'selection',
      paths: ['nope/file.ts'],
    });
    expect(view.status).toBe('failed');
    expect(view.failure?.code).toBe('EXPORT_NOTHING_TO_EXPORT');
  });
});

describe('secrets and credential files', () => {
  function withSecrets(): FakeProject {
    const project = seeded();
    project.write('.env', 'OPENAI_API_KEY=value-not-shown\n');
    project.write('.env.production', 'X=1\n');
    project.write('config/prod.env', 'X=1\n');
    project.write('.env.example', 'OPENAI_API_KEY=your_api_key_here\n');
    project.write('keys/server.pem', 'anything\n');
    project.write('.npmrc', '//registry.npmjs.org/:_authToken=abc\n');
    project.write('src/leak.ts', `export const t = "${FAKE_KEY}";\n`);
    project.write('src/clean.ts', 'export const key = process.env.KEY;\n');
    return project;
  }

  it('leaves credential files and secret-bearing files out, and says why', async () => {
    const { manager: m } = manager(withSecrets());
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('ready');

    const files = await extract(m.download(OWNER, view.exportId).bytes);
    const names = [...files.keys()];
    for (const forbidden of [
      '.env',
      '.env.production',
      'prod.env',
      'server.pem',
      '.npmrc',
      'leak.ts',
    ]) {
      expect(names.some((n) => n.endsWith(forbidden))).toBe(false);
    }
    // Templates and clean code stay.
    expect(names).toContain('My-App/.env.example');
    expect(names).toContain('My-App/src/clean.ts');

    const reasons = Object.fromEntries(view.excluded.map((e) => [e.path, e.reason]));
    expect(reasons['.env']).toBe('credential-file');
    expect(reasons['.env.production']).toBe('credential-file');
    expect(reasons['config/prod.env']).toBe('credential-file');
    expect(reasons['keys/server.pem']).toBe('credential-file');
    expect(reasons['.npmrc']).toBe('credential-file');
    expect(reasons['src/leak.ts']).toBe('secret-in-content');
  });

  it('never puts a secret value into the view, the archive, or an error', async () => {
    const { manager: m } = manager(withSecrets());
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    const { bytes } = m.download(OWNER, view.exportId);
    const everything = JSON.stringify(view) + Buffer.from(bytes).toString('latin1');
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain('value-not-shown');
    expect(everything).not.toContain('_authToken');
  });

  it('excludes a credential-bearing template: a name does not clear its content', async () => {
    const project = seeded();
    project.write('.env.example', `KEY=${FAKE_KEY}\n`);
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.excluded.map((e) => e.path)).toContain('.env.example');
  });

  it('fails clearly, not with an empty archive, when everything is excluded', async () => {
    const project = new FakeProject();
    project.write('.env', 'A=1\n');
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('failed');
    expect(view.failure?.code).toBe('EXPORT_NOTHING_TO_EXPORT');
    expect(view.excluded).toHaveLength(1);
    expect(() => m.download(OWNER, view.exportId)).toThrowError(/no archive/);
  });
});

describe('ownership', () => {
  it('answers a foreign project exactly like a missing one', async () => {
    const { manager: m } = manager(seeded());
    const foreign = await m.createExport('owner-b', { projectId: 'prj-1' }).catch((e) => e);
    const missing = await m.createExport(OWNER, { projectId: 'prj-404' }).catch((e) => e);
    expect(foreign.code).toBe('EXPORT_NOT_FOUND');
    expect(missing.code).toBe('EXPORT_NOT_FOUND');
    expect(foreign.message).toBe(missing.message);
  });

  it('keeps status, list and download private to the exporting owner', async () => {
    const { manager: m } = manager(seeded());
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(() => m.status('owner-b', view.exportId)).toThrowError(/not found/);
    expect(() => m.download('owner-b', view.exportId)).toThrowError(/not found/);
    expect(() => m.discard('owner-b', view.exportId)).toThrowError(/not found/);
    expect(m.list('owner-b')).toEqual([]);
    // ...and the owner still has it after the failed attempts.
    expect(m.download(OWNER, view.exportId).bytes.byteLength).toBeGreaterThan(0);
  });

  it('gives an unknown export id the same answer as a foreign one', async () => {
    const { manager: m } = manager(seeded());
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    const foreign = (() => {
      try {
        m.download('owner-b', view.exportId);
      } catch (e) {
        return e as Error;
      }
    })();
    const unknown = (() => {
      try {
        m.download('owner-b', 'exp_nope');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(foreign?.message).toBe(unknown?.message);
  });

  it('uses unguessable export ids', async () => {
    const { manager: m } = manager(seeded());
    const a = await m.createExport(OWNER, { projectId: 'prj-1' });
    const b = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(a.exportId).toMatch(/^exp_[A-Za-z0-9_-]{20,}$/);
    expect(a.exportId).not.toBe(b.exportId);
  });
});

describe('request validation and path traversal', () => {
  it.each([
    ['..'],
    ['../etc/passwd'],
    ['src/../../secret'],
    ['/etc/passwd'],
    ['C:/Windows/system.ini'],
    ['src\\..\\x'],
    ['src//index.ts'],
    ['./src'],
    ['%2e%2e/x'],
    ['src/%2e%2e/x'],
    ['a\u0000b'],
    [''],
  ])('rejects the path %j', async (path) => {
    const { manager: m } = manager(seeded());
    await expect(
      m.createExport(OWNER, { projectId: 'prj-1', scope: 'selection', paths: [path] }),
    ).rejects.toMatchObject({ code: 'EXPORT_PATH_INVALID' });
  });

  it.each([[123], [null], [{}], [''], ['../x'], ['a b'], ['x'.repeat(200)]])(
    'rejects the project id %j',
    async (projectId) => {
      const { manager: m } = manager(seeded());
      await expect(m.createExport(OWNER, { projectId })).rejects.toMatchObject({
        code: 'EXPORT_INVALID_REQUEST',
      });
    },
  );

  it('rejects an unknown scope and non-array paths', async () => {
    const { manager: m } = manager(seeded());
    await expect(m.createExport(OWNER, { projectId: 'prj-1', scope: 'all' })).rejects.toMatchObject(
      {
        code: 'EXPORT_INVALID_REQUEST',
      },
    );
    await expect(
      m.createExport(OWNER, { projectId: 'prj-1', scope: 'selection', paths: 'src' }),
    ).rejects.toMatchObject({ code: 'EXPORT_INVALID_REQUEST' });
  });

  it('caps how many paths a selection may name', async () => {
    const { manager: m } = manager(seeded());
    const paths = Array.from({ length: EXPORT_LIMITS.maxSelectionPaths + 1 }, (_, i) => `f${i}`);
    await expect(
      m.createExport(OWNER, { projectId: 'prj-1', scope: 'selection', paths }),
    ).rejects.toMatchObject({ code: 'EXPORT_INVALID_REQUEST' });
  });
});

describe('limits', () => {
  it('leaves out a file over the per-file limit and reports it', async () => {
    const project = seeded();
    project.write('big.txt', 'x'.repeat(EXPORT_LIMITS.maxFileBytes + 1));
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('ready');
    expect(view.excluded).toEqual([
      expect.objectContaining({ path: 'big.txt', reason: 'too-large' }),
    ]);
  });

  it('stops at the file-count limit and names what it dropped', async () => {
    const project = new FakeProject();
    for (let i = 0; i < EXPORT_LIMITS.maxFiles + 3; i += 1) {
      project.write(`f/${String(i).padStart(5, '0')}.txt`, 'a');
    }
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.totals.files).toBe(EXPORT_LIMITS.maxFiles);
    expect(view.excluded.filter((e) => e.reason === 'file-count-limit')).toHaveLength(3);
  });

  it('stops at the total-size limit rather than building an oversized archive', async () => {
    const project = new FakeProject();
    // Each file is UNDER the per-file limit, so only the total can stop the archive.
    const chunk = 'a'.repeat(EXPORT_LIMITS.maxFileBytes - 16);
    const needed = Math.ceil(EXPORT_LIMITS.maxTotalBytes / chunk.length) + 2;
    for (let i = 0; i < needed; i += 1)
      project.write(`d/${i}.txt`, `${i}:${chunk}`.slice(0, chunk.length));
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.totals.bytes).toBeLessThanOrEqual(EXPORT_LIMITS.maxTotalBytes);
    expect(view.excluded.some((e) => e.reason === 'total-size-limit')).toBe(true);
  });

  it('keeps at most a fixed number of archives per owner', async () => {
    const { manager: m, store } = manager(seeded());
    for (let i = 0; i < EXPORT_LIMITS.maxArchivesPerOwner + 4; i += 1) {
      await m.createExport(OWNER, { projectId: 'prj-1' });
    }
    expect(store.idsFor(OWNER).length).toBeLessThanOrEqual(EXPORT_LIMITS.maxArchivesPerOwner);
  });
});

describe('revision consistency', () => {
  it('retries when the project changes mid-read and exports ONE revision', async () => {
    const project = seeded();
    let mutated = false;
    project.onRead = (path) => {
      if (!mutated && path === 'src/index.ts') {
        mutated = true;
        project.write('src/index.ts', 'export const answer = 43;\n');
      }
    };
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('ready');
    expect(view.consistencyRetries).toBe(1);
    const files = await extract(m.download(OWNER, view.exportId).bytes);
    // The archive holds the NEW content everywhere, never a mixture.
    expect(files.get('My-App/src/index.ts')).toBe('export const answer = 43;\n');
    expect(view.revision).toBe(await project.workspaceRevision());
  });

  it('fails with a conflict, and builds no archive, if it never settles', async () => {
    const project = seeded();
    let n = 0;
    project.onRead = () => {
      n += 1;
      project.write('src/index.ts', `export const answer = ${n};\n`);
    };
    const { manager: m, store } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('failed');
    expect(view.failure?.code).toBe('EXPORT_REVISION_CONFLICT');
    expect(store.size()).toBe(0);
    expect(() => m.download(OWNER, view.exportId)).toThrowError(/no archive/);
  });

  it('detects a file added after the listing but before the read finished', async () => {
    const project = seeded();
    let added = false;
    project.onRead = (path) => {
      if (!added && path === 'Dockerfile') {
        added = true;
        project.write('late.txt', 'new');
      }
    };
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.consistencyRetries).toBe(1);
    expect(view.included.map((f) => f.path)).toContain('late.txt');
  });

  it('detects a file removed during the read', async () => {
    const project = seeded();
    let removed = false;
    project.onRead = (path) => {
      if (!removed && path === 'Dockerfile') {
        removed = true;
        project.remove('server/go.mod');
      }
    };
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('ready');
    expect(view.included.map((f) => f.path)).not.toContain('server/go.mod');
  });

  it('reports a file that cannot be read whole instead of skipping it silently', async () => {
    const project = seeded();
    project.failing.add('src/index.ts');
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.excluded).toEqual([
      expect.objectContaining({ path: 'src/index.ts', reason: 'unreadable' }),
    ]);
  });
});

describe('expiry, cleanup and failures', () => {
  it('expires an archive after its time and then refuses the download', async () => {
    let time = new Date('2026-11-05T10:00:00Z').getTime();
    const project = seeded();
    const { manager: m, store } = manager(project, () => new Date(time));
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(store.size()).toBe(1);
    time += EXPORT_LIMITS.archiveTtlMs + 1;
    expect(() => m.download(OWNER, view.exportId)).toThrowError(/expired/);
    expect(m.status(OWNER, view.exportId).status).toBe('expired');
    // The bytes are gone, not merely hidden.
    expect(store.size()).toBe(0);
  });

  it('discards an export and frees its bytes', async () => {
    const { manager: m, store } = manager(seeded());
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    m.discard(OWNER, view.exportId);
    expect(store.size()).toBe(0);
    expect(() => m.status(OWNER, view.exportId)).toThrowError(/not found/);
  });

  it('leaves no archive behind when an export fails', async () => {
    const project = new FakeProject();
    project.write('.env', 'A=1\n');
    const { manager: m, store } = manager(project);
    await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(store.size()).toBe(0);
  });

  it('turns an unexpected error into a generic failure that leaks nothing', async () => {
    const project = seeded();
    project.listNodes = async () => {
      throw new Error(`disk failure at /secret/path with ${FAKE_KEY}`);
    };
    const { manager: m } = manager(project);
    const view = await m.createExport(OWNER, { projectId: 'prj-1' });
    expect(view.status).toBe('failed');
    expect(view.failure?.code).toBe('EXPORT_INTERNAL');
    expect(JSON.stringify(view)).not.toContain('/secret/path');
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
  });
});

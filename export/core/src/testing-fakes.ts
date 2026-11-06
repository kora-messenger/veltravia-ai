import type { ExportNode, ExportSourcePort } from './ports.js';

/**
 * An in-memory project that behaves like the real engine where it matters to
 * export: every file has its own revision, and one workspace counter moves on
 * any change. Tests mutate it through the same methods a writer would.
 */
export class FakeProject implements ExportSourcePort {
  private files = new Map<string, { content: string; revision: number }>();
  private dirs = new Set<string>();
  private counter = 1;
  /** Called before each file read; tests use it to change the project mid-read. */
  onRead: ((path: string) => void) | null = null;
  /** Paths whose read throws, to model a file that cannot be returned whole. */
  readonly failing = new Set<string>();

  constructor(
    readonly ownerRef = 'owner-a',
    readonly projectId = 'prj-1',
    readonly workspaceId = 'ws-1',
    readonly name = 'My App',
  ) {}

  write(path: string, content: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) this.dirs.add(parts.slice(0, i).join('/'));
    this.counter += 1;
    this.files.set(path, { content, revision: this.counter });
  }

  remove(path: string): void {
    this.files.delete(path);
    this.counter += 1;
  }

  async resolveProject(input: { ownerRef: string; projectId: string }) {
    if (input.ownerRef !== this.ownerRef || input.projectId !== this.projectId) return null;
    return { projectId: this.projectId, workspaceId: this.workspaceId, name: this.name };
  }

  async listNodes(): Promise<readonly ExportNode[]> {
    return [
      ...[...this.dirs].map((path) => ({ path, type: 'directory' as const, revision: 1 })),
      ...[...this.files.entries()].map(([path, f]) => ({
        path,
        type: 'file' as const,
        revision: f.revision,
      })),
    ];
  }

  async workspaceRevision(): Promise<number> {
    return this.counter;
  }

  async readFile(_workspaceId: string, path: string) {
    this.onRead?.(path);
    if (this.failing.has(path)) throw new Error('boom');
    const file = this.files.get(path);
    if (file === undefined) throw new Error('missing');
    return { revision: file.revision, content: file.content };
  }
}

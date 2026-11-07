/**
 * A small in-memory project tree for tests.
 *
 * It behaves like the real port: writes bump a revision, snapshots are copies,
 * restore puts the whole tree back, and a scripted failure can be injected to
 * prove that a partial integration is compensated rather than left behind.
 */

import { contentHash, byteLength } from './hash.js';
import type {
  AppliedFile,
  ChangeOp,
  IntegrationTarget,
  IntegrationTreePort,
  ProjectPathState,
} from './types.js';

export interface FakeTreeOptions {
  /** Fail the nth apply call (1-based) for these paths. */
  readonly failOnPaths?: readonly string[];
}

export class InMemoryIntegrationTree implements IntegrationTreePort {
  private files = new Map<string, string>();
  private snapshots = new Map<string, Map<string, string>>();
  private revision = 1;
  private snapshotSeq = 0;
  private applyCalls = 0;
  readonly failOnPaths: Set<string>;

  constructor(initial: Record<string, string> = {}, options: FakeTreeOptions = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
    this.failOnPaths = new Set(options.failOnPaths ?? []);
  }

  /** Test helper: the tree as plain JSON. */
  dump(): Record<string, string> {
    return Object.fromEntries(Array.from(this.files.entries()).sort());
  }

  set(path: string, content: string): void {
    this.files.set(path, content);
    this.revision += 1;
  }

  get currentRevision(): number {
    return this.revision;
  }

  async snapshot(target: IntegrationTarget): Promise<{
    revision: number;
    files: readonly ProjectPathState[];
  }> {
    void target;
    const files: ProjectPathState[] = Array.from(this.files.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, content], index) => ({
        path,
        contentHash: contentHash(content),
        revision: index + 1,
        size: byteLength(content),
      }));
    return { revision: this.revision, files };
  }

  async read(target: IntegrationTarget, path: string): Promise<{ content: string } | null> {
    void target;
    const content = this.files.get(path);
    return content === undefined ? null : { content };
  }

  async apply(
    input: IntegrationTarget & {
      changes: readonly { path: string; op: ChangeOp; content: string | null }[];
      actor: never;
      summary: string;
    },
  ): Promise<{ revision: number; applied: readonly AppliedFile[] }> {
    void input.workspaceId;
    void input.actor;
    void input.summary;
    this.applyCalls += 1;
    const applied: AppliedFile[] = [];
    const before = new Map(this.files);

    for (const change of input.changes) {
      if (this.failOnPaths.has(change.path)) {
        // Put back anything written before the failure, like the real port.
        this.files = before;
        throw new Error(`Refused to write ${change.path}`);
      }
      const baseContent = this.files.get(change.path) ?? null;
      if (change.op === 'delete') {
        this.files.delete(change.path);
        applied.push({
          path: change.path,
          op: 'delete',
          baseHash: baseContent === null ? null : contentHash(baseContent),
          contentHash: null,
          afterHash: null,
        });
        continue;
      }
      const content = change.content ?? '';
      this.files.set(change.path, content);
      applied.push({
        path: change.path,
        op: change.op,
        baseHash: baseContent === null ? null : contentHash(baseContent),
        contentHash: contentHash(content),
        afterHash: contentHash(content),
      });
    }
    this.revision += 1;
    return { revision: this.revision, applied };
  }

  async restore(input: IntegrationTarget & { snapshotId: string }): Promise<{ revision: number }> {
    void input.workspaceId;
    const snapshot = this.snapshots.get(input.snapshotId);
    if (snapshot === undefined) throw new Error(`No snapshot ${input.snapshotId}`);
    this.files = new Map(snapshot);
    this.revision += 1;
    return { revision: this.revision };
  }

  async createSnapshot(
    input: IntegrationTarget & { label: string; note: string },
  ): Promise<{ snapshotId: string }> {
    void input.workspaceId;
    void input.label;
    void input.note;
    this.snapshotSeq += 1;
    const id = `snap_${this.snapshotSeq}`;
    this.snapshots.set(id, new Map(this.files));
    return { snapshotId: id };
  }

  get applies(): number {
    return this.applyCalls;
  }
}

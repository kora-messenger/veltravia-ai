import type { ExportNode, ExportSourcePort } from './ports.js';

/**
 * One consistent read of a workspace.
 *
 * "Consistent" is defined, not assumed: every file in the result was read at the
 * revision the tree reported, and the workspace revision was the same value
 * before the first read and after the last one. If anything moved in between,
 * the read is discarded and `changed: true` comes back, so a caller can retry
 * or refuse. Files from two different revisions are never combined.
 */

export interface RawFile {
  readonly path: string;
  readonly revision: number;
  readonly content: string;
}

export type ConsistentRead =
  | {
      readonly changed: false;
      readonly workspaceRevision: number;
      readonly files: readonly RawFile[];
      readonly unreadable: readonly string[];
      readonly directories: readonly string[];
    }
  | { readonly changed: true; readonly reason: string };

export async function readConsistently(
  source: ExportSourcePort,
  workspaceId: string,
  wanted: (node: ExportNode) => boolean,
): Promise<ConsistentRead> {
  const before = await source.workspaceRevision(workspaceId);
  const nodes = await source.listNodes(workspaceId);
  const fileNodes = nodes.filter((node) => node.type === 'file' && wanted(node));
  const directories = nodes
    .filter((node) => node.type === 'directory' && wanted(node))
    .map((node) => node.path);

  const files: RawFile[] = [];
  const unreadable: string[] = [];
  for (const node of fileNodes) {
    let read: { revision: number; content: string };
    try {
      read = await source.readFile(workspaceId, node.path);
    } catch {
      // A file listed a moment ago that cannot be read now has either vanished
      // (a change, caught below) or cannot be returned whole. Either way it is
      // not silently skipped: the revision check decides which.
      unreadable.push(node.path);
      continue;
    }
    if (read.revision !== node.revision) {
      return { changed: true, reason: 'A file changed while it was being read.' };
    }
    files.push({ path: node.path, revision: read.revision, content: read.content });
  }

  const after = await source.workspaceRevision(workspaceId);
  if (after !== before) {
    return { changed: true, reason: 'The project changed while the export was running.' };
  }
  // The revision counter is the primary guard; the tree comparison catches a
  // storage whose counter does not move on every kind of change.
  const nodesAfter = await source.listNodes(workspaceId);
  const filesAfter = nodesAfter.filter((node) => node.type === 'file' && wanted(node));
  if (filesAfter.length !== fileNodes.length) {
    return { changed: true, reason: 'Files were added or removed during the export.' };
  }
  const byPath = new Map(filesAfter.map((node) => [node.path, node.revision]));
  for (const node of fileNodes) {
    if (byPath.get(node.path) !== node.revision) {
      return { changed: true, reason: 'A file changed during the export.' };
    }
  }
  return {
    changed: false,
    workspaceRevision: before,
    files,
    unreadable,
    directories,
  };
}

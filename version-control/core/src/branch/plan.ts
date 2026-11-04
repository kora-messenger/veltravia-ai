import type { GatewayNode, RestoreStep } from '../gateway/index.js';
import type { SnapshotNode } from '../types/index.js';

function depth(path: string): number {
  return path.split('/').length;
}

/**
 * True when `path` is `selected` itself or sits underneath it. Compared by
 * whole segments, so selecting "src/a" does not also select "src/ab".
 */
export function pathIsUnder(path: string, selected: string): boolean {
  return path === selected || path.startsWith(`${selected}/`);
}

/** Normalises a requested path: no leading slash, no "..", no empty parts. */
export function normaliseSelectedPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed.includes('\0') || trimmed.includes('\\')) return null;
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

/**
 * The steps that turn the live tree into the snapshot, optionally for chosen
 * paths only.
 *
 * With `onlyPaths` set, a file is considered only if it is one of those paths
 * or sits under one. Everything else is left exactly as it is: no create, no
 * update and, importantly, no delete, so a partial restore cannot remove a file
 * the person did not name.
 *
 * Ordering matches the full rollback: directories shallow-to-deep, then files,
 * then deletions, then now-empty directories deep-first.
 */
export function planRestoreSteps(
  snapshotNodes: readonly SnapshotNode[],
  currentNodes: readonly GatewayNode[],
  onlyPaths?: readonly string[],
): RestoreStep[] {
  const inScope = (path: string): boolean =>
    onlyPaths === undefined || onlyPaths.some((selected) => pathIsUnder(path, selected));

  const currentByPath = new Map(currentNodes.map((node) => [node.path, node]));
  const targetByPath = new Map(snapshotNodes.map((node) => [node.path, node]));
  const steps: RestoreStep[] = [];

  const dirsToCreate = snapshotNodes
    .filter(
      (node) => node.type === 'directory' && inScope(node.path) && !currentByPath.has(node.path),
    )
    .sort((a, b) => depth(a.path) - depth(b.path));
  for (const node of dirsToCreate) steps.push({ kind: 'create_directory', path: node.path });

  // A file restored into a folder that does not exist yet needs that folder
  // first, even when only the file was named.
  if (onlyPaths !== undefined) {
    const have = new Set([
      ...currentNodes.filter((n) => n.type === 'directory').map((n) => n.path),
      ...dirsToCreate.map((n) => n.path),
    ]);
    for (const node of snapshotNodes) {
      if (node.type !== 'file' || !inScope(node.path)) continue;
      if (currentByPath.has(node.path)) continue;
      const parts = node.path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const parent = parts.slice(0, i).join('/');
        if (!have.has(parent) && targetByPath.get(parent)?.type === 'directory') {
          steps.push({ kind: 'create_directory', path: parent });
          have.add(parent);
        }
      }
    }
  }

  for (const node of snapshotNodes) {
    if (node.type !== 'file' || !inScope(node.path)) continue;
    const existing = currentByPath.get(node.path);
    if (existing === undefined) {
      steps.push({ kind: 'create_file', path: node.path, content: node.content });
    } else if (existing.type === 'file' && existing.content !== node.content) {
      steps.push({ kind: 'update_file', path: node.path, content: node.content });
    }
  }

  const filesToDelete = currentNodes
    .filter((node) => node.type === 'file' && inScope(node.path) && !targetByPath.has(node.path))
    .sort((a, b) => depth(a.path) - depth(b.path));
  for (const node of filesToDelete) steps.push({ kind: 'delete_file', path: node.path });

  const dirsToDelete = currentNodes
    .filter(
      (node) => node.type === 'directory' && inScope(node.path) && !targetByPath.has(node.path),
    )
    .sort((a, b) => depth(b.path) - depth(a.path));
  for (const node of dirsToDelete) steps.push({ kind: 'delete_directory', path: node.path });

  return steps;
}

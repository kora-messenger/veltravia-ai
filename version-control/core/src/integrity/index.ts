/**
 * Snapshot integrity (Step 18).
 *
 * Every snapshot carries a deterministic manifest hash: sha256 over the
 * sorted (path, type, size, content-hash) manifest. Restores verify the
 * target snapshot's integrity AND the resulting tree before any success is
 * reported. Failures fail closed.
 */

import { createHash } from 'node:crypto';

import type { SnapshotNode } from '../types/index.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Content hash of one file (empty string for directories). */
export function hashNodeContent(node: Pick<SnapshotNode, 'type' | 'content'>): string {
  if (node.type === 'directory') return '';
  return sha256Hex(node.content);
}

/**
 * Deterministic manifest hash over a sorted node list. Only metadata
 * participates (path, type, size, content hash) - the hash never encodes
 * content directly, but the content hash binds content integrity.
 */
export function manifestHashOf(nodes: readonly SnapshotNode[]): string {
  const lines = [...nodes]
    .map((node) => `${node.type}:${node.path}:${node.size}:${node.contentHash}`)
    .sort()
    .join('\n');
  return sha256Hex(lines);
}

/** Recomputes a manifest from gateway nodes (capture/verification path). */
export function manifestHashFromGateway(
  nodes: readonly {
    path: string;
    type: 'file' | 'directory';
    size: number;
    content: string | null;
  }[],
): { hash: string; totalBytes: number; snapshotNodes: SnapshotNode[] } {
  let totalBytes = 0;
  const snapshotNodes: SnapshotNode[] = nodes.map((node) => {
    const content = node.type === 'file' ? (node.content ?? '') : '';
    const entry: SnapshotNode = {
      path: node.path,
      type: node.type,
      size: content.length,
      content,
      contentHash: node.type === 'file' ? sha256Hex(content) : '',
    };
    if (node.type === 'file') totalBytes += content.length;
    return entry;
  });
  snapshotNodes.sort((a, b) => a.path.localeCompare(b.path));
  return { hash: manifestHashOf(snapshotNodes), totalBytes, snapshotNodes };
}

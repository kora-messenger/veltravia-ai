/**
 * Bounded diff engine (Step 18).
 *
 * Compares two snapshot node sets and produces a structured, CAPPED
 * comparison. File content is UNTRUSTED PROJECT DATA: line detail is only
 * produced for text files within hard caps, binary-like content never
 * yields lines, and every cap raises an honest truncation flag. The engine
 * never returns unbounded output.
 */

import type { DiffLine, FileDiff, RevisionComparison, SnapshotNode } from '../types/index.js';
import { hashNodeContent } from '../integrity/index.js';

export const DIFF_LIMITS = {
  /** Max files in one comparison response. */
  maxFiles: 200,
  /** Max files with line-level detail. */
  maxFilesWithLines: 50,
  /** Max lines per file diff. */
  maxLinesPerFile: 400,
  /** Files above this line count get file-level stats only. */
  maxFileLinesForDetail: 2000,
} as const;

/** Binary-like when it contains C0/C1 control characters other than \t\n\r. */
export function isBinaryContent(content: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(content);
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/);
}

/**
 * Bounded line diff via a size-capped LCS table. For inputs beyond the cap
 * the caller skips line detail entirely (honest truncation, not a hang).
 */
export function lineDiff(
  oldContent: string,
  newContent: string,
): {
  lines: DiffLine[];
  truncated: boolean;
} {
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  if (a.length + b.length > DIFF_LIMITS.maxFileLinesForDetail * 2) {
    return { lines: [], truncated: true };
  }
  // LCS table with strict-safe access.
  const aLines: string[] = [...a];
  const bLines: string[] = [...b];
  const rows = aLines.length + 1;
  const cols = bLines.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const at = (grid: number[][], row: number, col: number): number => grid[row]?.[col] ?? 0;
  for (let i = rows - 2; i >= 0; i -= 1) {
    for (let j = cols - 2; j >= 0; j -= 1) {
      const aLine = aLines[i] ?? '';
      const bLine = bLines[j] ?? '';
      table[i]![j] =
        aLine === bLine
          ? at(table, i + 1, j + 1) + 1
          : Math.max(at(table, i + 1, j), at(table, i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let truncated = false;
  const push = (kind: DiffLine['kind'], text: string): void => {
    lines.push({ kind, text });
    if (lines.length >= DIFF_LIMITS.maxLinesPerFile) truncated = true;
  };
  while (i < aLines.length && j < bLines.length && !truncated) {
    const aLine = aLines[i] ?? '';
    const bLine = bLines[j] ?? '';
    if (aLine === bLine) {
      push('context', aLine);
      i += 1;
      j += 1;
    } else if (at(table, i + 1, j) >= at(table, i, j + 1)) {
      push('del', aLine);
      i += 1;
    } else {
      push('add', bLine);
      j += 1;
    }
  }
  while (i < aLines.length && !truncated) {
    push('del', aLines[i] ?? '');
    i += 1;
  }
  while (j < bLines.length && !truncated) {
    push('add', bLines[j] ?? '');
    j += 1;
  }
  return { lines, truncated };
}

interface NodeIndex {
  readonly byPath: ReadonlyMap<string, SnapshotNode>;
}

/**
 * Compares two snapshot node sets. `from` is the older state, `to` the newer.
 * Rename detection: a deleted file whose content hash equals an added file's
 * content hash is reported as a rename (the only safely detectable case).
 */
export function compareSnapshots(
  from: readonly SnapshotNode[],
  to: readonly SnapshotNode[],
): RevisionComparison {
  const fromIndex: NodeIndex = {
    byPath: new Map(from.map((node) => [node.path, node])),
  };
  const toByPath = new Map(to.map((node) => [node.path, node]));

  const deletedFiles: SnapshotNode[] = [];
  const addedFiles: SnapshotNode[] = [];
  const modified: Array<{ from: SnapshotNode; to: SnapshotNode }> = [];
  const unchanged: SnapshotNode[] = [];

  for (const node of from) {
    const other = toByPath.get(node.path);
    if (other === undefined) {
      if (node.type === 'file') deletedFiles.push(node);
      continue;
    }
    if (node.type !== other.type || node.contentHash !== other.contentHash) {
      if (node.type === 'file' && other.type === 'file') {
        modified.push({ from: node, to: other });
      }
    } else if (node.type === 'file') {
      unchanged.push(node);
    }
  }
  for (const node of to) {
    if (!fromIndex.byPath.has(node.path) && node.type === 'file') addedFiles.push(node);
  }

  // Rename detection by identical content hash.
  const deletedByHash = new Map<string, SnapshotNode>();
  for (const node of deletedFiles) {
    if (!deletedByHash.has(node.contentHash)) deletedByHash.set(node.contentHash, node);
  }
  const renames: Array<{ from: SnapshotNode; to: SnapshotNode }> = [];
  const remainingAdded: SnapshotNode[] = [];
  const remainingDeleted: SnapshotNode[] = [];
  const usedDeleted = new Set<string>();
  for (const node of addedFiles) {
    const match = deletedByHash.get(node.contentHash);
    if (match !== undefined && !usedDeleted.has(match.path)) {
      renames.push({ from: match, to: node });
      usedDeleted.add(match.path);
    } else {
      remainingAdded.push(node);
    }
  }
  for (const node of deletedFiles) {
    if (!usedDeleted.has(node.path)) remainingDeleted.push(node);
  }

  const candidateDiffs: FileDiff[] = [];
  const build = (
    kind: FileDiff['kind'],
    node: SnapshotNode,
    previousPath: string | null,
    oldNode: SnapshotNode | null,
  ): void => {
    const oldSize = oldNode?.size ?? 0;
    const newSize = node.size;
    const oldContent = oldNode?.content ?? '';
    const newContent = node.content;
    const binary = isBinaryContent(newContent) || isBinaryContent(oldContent);
    let lines: DiffLine[] = [];
    let linesTruncated = false;
    if (kind === 'renamed' && oldNode !== null && oldNode.contentHash === node.contentHash) {
      // Pure rename: no line detail needed.
    } else if (!binary && (kind === 'modified' || kind === 'renamed')) {
      const detail = lineDiff(oldContent, newContent);
      lines = detail.lines;
      linesTruncated = detail.truncated;
    } else if (!binary && (kind === 'added' || kind === 'deleted')) {
      const content = kind === 'added' ? newContent : oldContent;
      const source = splitLines(content);
      const cap = Math.min(source.length, DIFF_LIMITS.maxLinesPerFile);
      lines = source.slice(0, cap).map((text) => ({
        kind: kind === 'added' ? ('add' as const) : ('del' as const),
        text,
      }));
      linesTruncated = source.length > cap;
    }
    candidateDiffs.push({
      path: node.path,
      kind,
      previousPath,
      oldSize,
      newSize,
      sizeDelta: newSize - oldSize,
      binary,
      lines,
      linesTruncated,
    });
  };

  for (const rename of renames) {
    build('renamed', rename.to, rename.from.path, rename.from);
  }
  for (const entry of modified) {
    build('modified', entry.to, null, entry.from);
  }
  for (const node of remainingAdded) {
    build('added', node, null, null);
  }
  for (const node of remainingDeleted) {
    build('deleted', node, null, node);
  }

  candidateDiffs.sort((a, b) => a.path.localeCompare(b.path));
  const capped = candidateDiffs.slice(0, DIFF_LIMITS.maxFiles);
  let lineBudget = DIFF_LIMITS.maxFilesWithLines;
  const files: FileDiff[] = capped.map((file) => {
    if (file.lines.length === 0 || file.binary || lineBudget <= 0) {
      if (file.lines.length > 0 && lineBudget <= 0) {
        return { ...file, lines: [], linesTruncated: true };
      }
      return file;
    }
    lineBudget -= 1;
    return file;
  });

  return {
    fromRevisionId: '',
    toRevisionId: '',
    added: remainingAdded.length,
    modified: modified.length,
    deleted: remainingDeleted.length,
    unchanged: unchanged.length,
    renamed: renames.length,
    files,
    filesTruncated: candidateDiffs.length > capped.length,
    totalBytesChanged: files.reduce((sum, file) => sum + Math.abs(file.sizeDelta), 0),
  };
}

/** Computes the change counts of one capture relative to the previous snapshot. */
export function changeCounts(
  previous: readonly SnapshotNode[],
  next: readonly SnapshotNode[],
): { added: number; modified: number; deleted: number } {
  const previousByPath = new Map(previous.map((node) => [node.path, node]));
  const nextByPath = new Map(next.map((node) => [node.path, node]));
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const node of previous) {
    const other = nextByPath.get(node.path);
    if (other === undefined) {
      if (node.type === 'file') deleted += 1;
      continue;
    }
    if (
      node.type === 'file' &&
      other.type === 'file' &&
      node.contentHash !== hashNodeContent(other)
    ) {
      modified += 1;
    }
  }
  for (const node of next) {
    if (!previousByPath.has(node.path) && node.type === 'file') added += 1;
  }
  return { added, modified, deleted };
}

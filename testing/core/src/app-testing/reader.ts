/**
 * Reads a workspace's files for inspection, through the Tool System only.
 *
 * This is the one place the application-testing agent reads project data. It
 * never touches a host path and never executes anything. The rules:
 *
 *  - Every read goes through `project.list-files` and `project.read-file`, so
 *    the Tool System's grants and validation apply.
 *  - Files that look like they hold secrets (`.env`, key files) are listed by
 *    path but their CONTENTS ARE NEVER READ. Static security checks still see
 *    that they exist.
 *  - Reads are bounded: a directory depth, a file count, a per-file size and a
 *    total byte budget. Hitting any bound is reported, never hidden.
 *  - Everything read is UNTRUSTED data. It is returned as text and nothing
 *    here interprets it.
 */

import type { ToolInvocationResult, ToolManager } from '@veltravia/tool-core';

import { APP_TEST_LIMITS, type InspectableFile } from './types.js';

const TOOL_LIST = 'project.list-files';
const TOOL_READ = 'project.read-file';

const MAX_DEPTH = 6;
const MAX_TOTAL_BYTES = 4_000_000;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);
/** Extensions whose text is worth reading. Everything else is listed only. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.vue',
  '.svelte',
  '.prisma',
  '.sql',
  '.html',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
]);

/** Paths whose contents must never be read into memory. */
export function isSecretShapedPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (/^\.env($|\.)/.test(name)) return !/\.(example|sample|template)$/.test(name);
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
  if (/^(credentials|secrets?)(\.|$)/i.test(name)) return true;
  return false;
}

function isReadableText(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (name === 'package.json' || name === 'Dockerfile') return true;
  // Example env files hold placeholders, not secrets, and are worth reading.
  if (/^\.env\.(example|sample|template)$/.test(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

interface Node {
  readonly path: string;
  readonly type: 'file' | 'directory';
}

function nodesOf(result: ToolInvocationResult): readonly Node[] {
  const output = result.output as { nodes?: unknown } | undefined;
  if (!Array.isArray(output?.nodes)) return [];
  const nodes: Node[] = [];
  for (const raw of output.nodes as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { path?: unknown; type?: unknown };
    if (typeof entry.path !== 'string') continue;
    if (entry.type !== 'file' && entry.type !== 'directory') continue;
    nodes.push({ path: entry.path, type: entry.type });
  }
  return nodes;
}

export interface ReadWorkspaceResult {
  readonly files: readonly InspectableFile[];
  readonly truncated: boolean;
  /** Plain-words notes: bounds hit, files unreadable, paths withheld. */
  readonly notes: readonly string[];
  /** Set when a tool call needs a person's decision before it can go on. */
  readonly pausedForConfirmation: boolean;
}

export interface ReadWorkspaceOptions {
  readonly tools: ToolManager;
  readonly workspaceId: string;
  /** Who is asking, recorded by the Tool System. */
  readonly requester?: string;
}

/** Lists and reads a workspace within bounds. Never throws on a missing file. */
export async function readWorkspace(options: ReadWorkspaceOptions): Promise<ReadWorkspaceResult> {
  const { tools, workspaceId } = options;
  const requester = options.requester ?? 'app-testing-agent';
  const notes: string[] = [];
  const files: InspectableFile[] = [];
  let truncated = false;
  let paused = false;
  let totalBytes = 0;
  let withheld = 0;
  let unreadable = 0;

  const invoke = (toolId: string, input: Record<string, unknown>) =>
    tools.invoke(toolId, input, { requester });

  // Breadth-first listing, bounded by depth and file count.
  const queue: { path: string | null; depth: number }[] = [{ path: null, depth: 0 }];
  const listed: Node[] = [];
  while (queue.length > 0 && !truncated) {
    const next = queue.shift() as { path: string | null; depth: number };
    const result = await invoke(TOOL_LIST, {
      workspaceId,
      ...(next.path !== null ? { path: next.path } : {}),
    });
    if (result.status === 'awaiting_confirmation') {
      paused = true;
      break;
    }
    if (result.status !== 'success') {
      notes.push(
        next.path === null
          ? 'The workspace could not be listed.'
          : `A folder could not be listed: ${next.path}.`,
      );
      continue;
    }
    for (const node of nodesOf(result)) {
      const name = node.path.split('/').pop() ?? node.path;
      if (node.type === 'directory') {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        if (next.depth + 1 > MAX_DEPTH) {
          notes.push(`Folders deeper than ${MAX_DEPTH} levels were not opened.`);
          truncated = true;
          continue;
        }
        queue.push({ path: node.path, depth: next.depth + 1 });
      } else {
        if (listed.length >= APP_TEST_LIMITS.maxFiles) {
          truncated = true;
          break;
        }
        listed.push(node);
      }
    }
  }
  if (listed.length >= APP_TEST_LIMITS.maxFiles) {
    notes.push(`Only the first ${APP_TEST_LIMITS.maxFiles} files were inspected.`);
  }

  listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const node of listed) {
    if (paused) break;
    if (isSecretShapedPath(node.path)) {
      // Present by path so checks can flag it; contents are never read.
      files.push({ path: node.path, text: null });
      withheld += 1;
      continue;
    }
    if (!isReadableText(node.path) || totalBytes >= MAX_TOTAL_BYTES) {
      files.push({ path: node.path, text: null });
      continue;
    }
    const result = await invoke(TOOL_READ, { workspaceId, path: node.path });
    if (result.status === 'awaiting_confirmation') {
      paused = true;
      break;
    }
    const content = (result.output as { content?: unknown } | undefined)?.content;
    if (result.status !== 'success' || typeof content !== 'string') {
      files.push({ path: node.path, text: null });
      unreadable += 1;
      continue;
    }
    const bounded =
      content.length > APP_TEST_LIMITS.maxFileBytes
        ? content.slice(0, APP_TEST_LIMITS.maxFileBytes)
        : content;
    totalBytes += bounded.length;
    files.push({ path: node.path, text: bounded });
  }

  if (files.length === 0 && !paused) {
    // The Tool System answers an unknown workspace with an empty list, so an
    // empty result cannot be told apart from a project with no files.
    notes.push(
      'No files were found. The workspace may be empty, or the workspace id may be wrong.',
    );
  }
  if (totalBytes >= MAX_TOTAL_BYTES) {
    notes.push('The size budget was reached, so some files were listed but not read.');
    truncated = true;
  }
  if (withheld > 0) {
    notes.push(
      `${withheld} file${withheld === 1 ? '' : 's'} that may hold secrets ${withheld === 1 ? 'was' : 'were'} listed but never read.`,
    );
  }
  if (unreadable > 0) {
    notes.push(`${unreadable} file${unreadable === 1 ? '' : 's'} could not be read.`);
  }

  return { files, truncated, notes, pausedForConfirmation: paused };
}

/**
 * File-tree storage: one row per node, content in the row.
 *
 * Content lives beside the metadata so a file write and its size update are the
 * same statement (atomic, no torn state). Listing never selects `content`, so a
 * thousand-file tree does not drag a megabyte of source over the wire just to
 * draw a tree.
 */

import { randomUUID } from 'node:crypto';

import {
  FileNodeNotFoundError,
  type FileNode,
  type FileNodeChangeSet,
  type FileRepository,
  type NewFileNode,
  type NodeType,
  ProjectError,
  RevisionConflictError,
} from '@veltravia/project-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

/** Columns returned for tree reads. Deliberately excludes `content`. */
const NODE_COLUMNS =
  'id, workspace_id, path, name, type, parent_id, size, revision, created_at, updated_at';

interface NodeRow {
  id: string;
  workspace_id: string;
  path: string;
  name: string;
  type: string;
  parent_id: string | null;
  size: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function toNode(row: NodeRow): FileNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    name: row.name,
    type: row.type as NodeType,
    parentId: row.parent_id,
    size: Number(row.size),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function byteLength(content: string | null): number {
  return content === null ? 0 : Buffer.byteLength(content, 'utf8');
}

/** Escapes LIKE wildcards so a path containing `%` or `_` cannot widen a move. */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
}

export class PostgresFileRepository implements FileRepository {
  private readonly query: Queryable;
  private readonly generateId: () => string;

  constructor(query: Queryable, options: { generateId?: () => string } = {}) {
    this.query = query;
    this.generateId = options.generateId ?? (() => `node_${randomUUID()}`);
  }

  async createNode(input: NewFileNode): Promise<FileNode> {
    const owner = requireOwner();
    const content = input.type === 'file' ? (input.content ?? null) : null;
    try {
      const rows = await this.query.query<NodeRow>(
        `insert into file_nodes
           (id, workspace_id, owner_ref, path, name, type, parent_id, content, size,
            revision, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)
         returning ${NODE_COLUMNS}`,
        [
          this.generateId(),
          input.workspaceId,
          owner,
          input.path,
          input.name,
          input.type,
          input.parentId,
          content,
          byteLength(content),
          input.createdAt,
        ],
      );
      return toNode(rows.rows[0]!);
    } catch (error) {
      throw mapFileError(error, input.path);
    }
  }

  async getNode(workspaceId: string, path: string): Promise<FileNode | null> {
    const owner = requireOwner();
    const rows = await this.query.query<NodeRow>(
      `select ${NODE_COLUMNS} from file_nodes
        where workspace_id = $1 and path = $2 and owner_ref = $3`,
      [workspaceId, path, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toNode(row);
  }

  async getNodeById(workspaceId: string, nodeId: string): Promise<FileNode | null> {
    const owner = requireOwner();
    const rows = await this.query.query<NodeRow>(
      `select ${NODE_COLUMNS} from file_nodes
        where workspace_id = $1 and id = $2 and owner_ref = $3`,
      [workspaceId, nodeId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toNode(row);
  }

  async listChildren(workspaceId: string, path: string): Promise<FileNode[]> {
    const owner = requireOwner();
    const prefix = path === '' ? '' : `${path}/`;
    // Direct children only: the path starts with the prefix and the remainder
    // carries no further separator. `like` is avoided here so a path that
    // contains a wildcard character cannot widen the result.
    const rows = await this.query.query<NodeRow>(
      `select ${NODE_COLUMNS} from file_nodes
        where workspace_id = $1 and owner_ref = $2
          and path <> $3
          and left(path, $4) = $3
          and position('/' in substr(path, $4 + 1)) = 0
        order by path asc`,
      [workspaceId, owner, prefix, prefix.length],
    );
    return rows.rows.map(toNode);
  }

  async listAll(workspaceId: string): Promise<FileNode[]> {
    const owner = requireOwner();
    const rows = await this.query.query<NodeRow>(
      `select ${NODE_COLUMNS} from file_nodes
        where workspace_id = $1 and owner_ref = $2
        order by path asc`,
      [workspaceId, owner],
    );
    return rows.rows.map(toNode);
  }

  async updateNode(
    workspaceId: string,
    nodeId: string,
    change: FileNodeChangeSet,
  ): Promise<FileNode> {
    const owner = requireOwner();
    const setsContent = change.patch.content !== undefined;
    try {
      const rows = await this.query.query<NodeRow>(
        `update file_nodes
            set path = coalesce($4, path),
                name = coalesce($5, name),
                parent_id = case when $6::boolean then $7 else parent_id end,
                content = case when $8::boolean then $9 else content end,
                size = case when $8::boolean then $10 else size end,
                revision = revision + 1,
                updated_at = $11
          where workspace_id = $1 and id = $2 and owner_ref = $3 and revision = $12
        returning ${NODE_COLUMNS}`,
        [
          workspaceId,
          nodeId,
          owner,
          change.patch.path ?? null,
          change.patch.name ?? null,
          change.patch.parentId !== undefined,
          change.patch.parentId ?? null,
          setsContent,
          setsContent ? (change.patch.content ?? null) : null,
          setsContent ? byteLength(change.patch.content ?? null) : 0,
          change.updatedAt,
          change.expectedRevision,
        ],
      );
      const updated = rows.rows[0];
      if (updated !== undefined) return toNode(updated);

      const existing = await this.query.query<{ revision: number }>(
        'select revision from file_nodes where workspace_id = $1 and id = $2 and owner_ref = $3',
        [workspaceId, nodeId, owner],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new FileNodeNotFoundError(nodeId);
      throw new RevisionConflictError('file', change.expectedRevision, row.revision);
    } catch (error) {
      throw mapFileError(error, change.patch.path ?? nodeId);
    }
  }

  async moveSubtree(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    updatedAt: string,
  ): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `update file_nodes
          set path = $4 || substr(path, $5),
              updated_at = $6
        where workspace_id = $1 and owner_ref = $2 and path like $3 escape '\\'`,
      [workspaceId, owner, likePrefix(fromPath), toPath, fromPath.length + 1, updatedAt],
    );
  }

  async deleteNode(workspaceId: string, nodeId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      'delete from file_nodes where workspace_id = $1 and id = $2 and owner_ref = $3',
      [workspaceId, nodeId, owner],
    );
  }

  async readContent(workspaceId: string, nodeId: string): Promise<string | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ content: string | null }>(
      `select content from file_nodes
        where workspace_id = $1 and id = $2 and owner_ref = $3`,
      [workspaceId, nodeId, owner],
    );
    return rows.rows[0]?.content ?? null;
  }
}

/**
 * Translates a unique-path violation into the engine's typed conflict. Any
 * other storage failure keeps its own type so the route can map it.
 */
function mapFileError(error: unknown, path: string): unknown {
  if (error instanceof ProjectError) return error;
  const constraint =
    typeof error === 'object' && error !== null && 'constraint' in error
      ? String((error as { constraint?: unknown }).constraint)
      : '';
  if (constraint === 'file_nodes_workspace_path_key') {
    return new ProjectError('PATH_CONFLICT', `A file or directory already exists at "${path}".`);
  }
  return error;
}

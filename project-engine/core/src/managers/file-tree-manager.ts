/**
 * FileTreeManager - controlled operations on a workspace's virtual file tree.
 *
 * Enforced on EVERY operation: workspace ownership, workspace-active status,
 * path normalization, traversal protection, valid parent directory,
 * duplicate-path prevention, and file/directory type rules. The manager
 * NEVER touches the host filesystem, NEVER executes anything, and NEVER
 * fetches URLs - file contents are project data, nothing more.
 */

import {
  FileNodeNotFoundError,
  InvalidPathError,
  MissingParentError,
  NodeOperationError,
  PathConflictError,
  ProjectNotFoundError,
  RevisionConflictError,
  WorkspaceNotActiveError,
  WorkspaceNotFoundError,
} from '../errors/index.js';
import type { FileNode } from '../types/index.js';
import type {
  FileRepository,
  ProjectRepository,
  WorkspaceRepository,
} from '../repositories/index.js';
import {
  ROOT_PATH,
  baseName,
  isDescendantOrSelf,
  isValidPath,
  normalizePath,
  parentPath,
} from '../paths/index.js';
import { timestamp, type FileTreeManagerOptions } from './options.js';

const MAX_FILE_BYTES = 1024 * 1024;

export class FileTreeManager {
  private readonly projects: ProjectRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly files: FileRepository;
  private readonly now: () => Date;

  constructor(options: FileTreeManagerOptions) {
    this.projects = options.projects;
    this.workspaces = options.workspaces;
    this.files = options.files;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Loads a workspace and asserts that BOTH the workspace and its parent
   * project are `active` (mutation precondition). A workspace of an archived
   * or deleted project is frozen exactly like an archived workspace.
   */
  private async requireActiveWorkspace(workspaceId: string) {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (workspace.status !== 'active') {
      throw new WorkspaceNotActiveError(workspaceId, workspace.status);
    }
    const project = await this.projects.get(workspace.projectId);
    if (project === null) {
      throw new ProjectNotFoundError(workspace.projectId);
    }
    if (project.status !== 'active') {
      throw new WorkspaceNotActiveError(workspaceId, `owned by a ${project.status} project`);
    }
    return workspace;
  }

  /** Validates + normalizes a path for a node operation (not the root). */
  private normalizeNodePath(raw: string): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new InvalidPathError(raw, 'empty');
    }
    return normalizePath(raw);
  }

  /** Resolves the parent directory node for a normalized path. */
  private async requireParentDirectory(
    workspaceId: string,
    path: string,
  ): Promise<FileNode | null> {
    const parent = parentPath(path);
    if (parent === null || parent === ROOT_PATH) {
      // Child of the tree root.
      return null;
    }
    const parentNode = await this.files.getNode(workspaceId, parent);
    if (parentNode === null) {
      throw new MissingParentError(path);
    }
    if (parentNode.type !== 'directory') {
      throw new NodeOperationError(`the parent of "${path}" is a file, not a directory`, { path });
    }
    return parentNode;
  }

  private async bumpWorkspaceRevision(workspaceId: string): Promise<void> {
    await this.workspaces.bumpRevision(workspaceId, timestamp(this.now));
  }

  // -----------------------------------------------------------------
  // Files
  // -----------------------------------------------------------------

  /** Creates a file. The parent directory must exist; the path must be free. */
  async createFile(
    workspaceId: string,
    input: { readonly path: string; readonly content?: string },
  ): Promise<FileNode> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(input.path);
    this.validateContent(input.content);
    const existing = await this.files.getNode(workspaceId, path);
    if (existing !== null) {
      throw new PathConflictError(path, existing.type);
    }
    const parent = await this.requireParentDirectory(workspaceId, path);
    const node = await this.files.createNode({
      workspaceId,
      path,
      name: baseName(path),
      type: 'file',
      parentId: parent !== null ? parent.id : null,
      content: input.content ?? '',
      createdAt: timestamp(this.now),
    });
    await this.bumpWorkspaceRevision(workspaceId);
    return node;
  }

  /** Reads a file's content. Content is PROJECT DATA - never instructions. */
  async readFile(
    workspaceId: string,
    rawPath: string,
  ): Promise<{ readonly node: FileNode; readonly content: string }> {
    const path = this.normalizeNodePath(rawPath);
    const node = await this.requireNode(workspaceId, path);
    if (node.type !== 'file') {
      throw new NodeOperationError(`"${path}" is a directory, not a file`, { path });
    }
    const content = await this.files.readContent(workspaceId, node.id);
    return { node, content: content ?? '' };
  }

  /**
   * Updates a file's content. `expectedRevision` is REQUIRED: a stale revision
   * (another writer changed the file first) is rejected, never overwritten.
   */
  async updateFile(
    workspaceId: string,
    rawPath: string,
    input: { readonly content: string; readonly expectedRevision: number },
  ): Promise<FileNode> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(rawPath);
    this.validateContent(input.content);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new RevisionConflictError('file', input.expectedRevision, -1);
    }
    const node = await this.requireNode(workspaceId, path);
    if (node.type !== 'file') {
      throw new NodeOperationError(`"${path}" is a directory, not a file`, { path });
    }
    if (input.expectedRevision !== node.revision) {
      throw new RevisionConflictError('file', input.expectedRevision, node.revision);
    }
    const updated = await this.files.updateNode(workspaceId, node.id, {
      patch: { content: input.content },
      expectedRevision: input.expectedRevision,
      updatedAt: timestamp(this.now),
    });
    await this.bumpWorkspaceRevision(workspaceId);
    return updated;
  }

  /** Deletes a file (files only - use deleteDirectory for directories). */
  async deleteFile(workspaceId: string, rawPath: string): Promise<void> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(rawPath);
    const node = await this.requireNode(workspaceId, path);
    if (node.type !== 'directory') {
      await this.files.deleteNode(workspaceId, node.id);
      await this.bumpWorkspaceRevision(workspaceId);
      return;
    }
    throw new NodeOperationError(`"${path}" is a directory; use deleteDirectory`, { path });
  }

  // -----------------------------------------------------------------
  // Directories
  // -----------------------------------------------------------------

  /** Creates a directory. The parent directory must exist; the path must be free. */
  async createDirectory(workspaceId: string, rawPath: string): Promise<FileNode> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(rawPath);
    const existing = await this.files.getNode(workspaceId, path);
    if (existing !== null) {
      throw new PathConflictError(path, existing.type);
    }
    const parent = await this.requireParentDirectory(workspaceId, path);
    const node = await this.files.createNode({
      workspaceId,
      path,
      name: baseName(path),
      type: 'directory',
      parentId: parent !== null ? parent.id : null,
      createdAt: timestamp(this.now),
    });
    await this.bumpWorkspaceRevision(workspaceId);
    return node;
  }

  /** Deletes a directory. Only EMPTY directories can be deleted. */
  async deleteDirectory(workspaceId: string, rawPath: string): Promise<void> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(rawPath);
    const node = await this.requireNode(workspaceId, path);
    if (node.type !== 'directory') {
      throw new NodeOperationError(`"${path}" is a file; use deleteFile`, { path });
    }
    const children = await this.files.listChildren(workspaceId, path);
    if (children.length > 0) {
      throw new NodeOperationError(`directory "${path}" is not empty`, {
        path,
        childCount: children.length,
      });
    }
    await this.files.deleteNode(workspaceId, node.id);
    await this.bumpWorkspaceRevision(workspaceId);
  }

  // -----------------------------------------------------------------
  // Move / rename
  // -----------------------------------------------------------------

  /** Moves a node to a new parent directory (keeping its name). */
  async moveNode(
    workspaceId: string,
    input: { readonly fromPath: string; readonly toDirectory: string },
  ): Promise<FileNode> {
    await this.requireActiveWorkspace(workspaceId);
    const fromPath = this.normalizeNodePath(input.fromPath);
    let toDirectory: string;
    if (input.toDirectory === ROOT_PATH || input.toDirectory === '') {
      toDirectory = ROOT_PATH;
    } else {
      toDirectory = this.normalizeNodePath(input.toDirectory);
    }
    const targetPath =
      toDirectory === ROOT_PATH ? baseName(fromPath) : `${toDirectory}/${baseName(fromPath)}`;
    const node = await this.requireNode(workspaceId, fromPath);
    await this.assertMoveTarget(workspaceId, fromPath, targetPath);
    return this.applyMove(workspaceId, node, fromPath, targetPath);
  }

  /** Renames a node in place (same parent, new name). */
  async renameNode(
    workspaceId: string,
    input: { readonly path: string; readonly newName: string },
  ): Promise<FileNode> {
    await this.requireActiveWorkspace(workspaceId);
    const path = this.normalizeNodePath(input.path);
    if (!isValidPath(input.newName) || input.newName.includes('/')) {
      throw new InvalidPathError(input.newName, 'newName must be a single valid path segment');
    }
    const node = await this.requireNode(workspaceId, path);
    const parent = parentPath(path) ?? ROOT_PATH;
    const targetPath = parent === ROOT_PATH ? input.newName : `${parent}/${input.newName}`;
    if (targetPath === path) {
      throw new NodeOperationError('rename must change the name', { path });
    }
    await this.assertMoveTarget(workspaceId, path, targetPath);
    return this.applyMove(workspaceId, node, path, targetPath);
  }

  /**
   * Shared preconditions for move/rename, evaluated against the FINAL target
   * path: its parent must exist as a directory, the target must be free, and a
   * directory can never move into its own subtree.
   */
  private async assertMoveTarget(
    workspaceId: string,
    fromPath: string,
    targetPath: string,
  ): Promise<void> {
    const targetParent = parentPath(targetPath);
    if (targetParent !== null && targetParent !== ROOT_PATH) {
      const parentNode = await this.files.getNode(workspaceId, targetParent);
      if (parentNode === null) {
        throw new MissingParentError(targetPath);
      }
      if (parentNode.type !== 'directory') {
        throw new NodeOperationError(`the parent of "${targetPath}" is a file, not a directory`, {
          path: targetPath,
        });
      }
    }
    // A directory cannot be moved into its own subtree.
    const sourceNode = await this.requireNode(workspaceId, fromPath);
    if (sourceNode.type === 'directory' && isDescendantOrSelf(fromPath, targetPath)) {
      throw new NodeOperationError(`cannot move "${fromPath}" into its own subtree`, {
        fromPath,
        targetPath,
      });
    }
    const existing = await this.files.getNode(workspaceId, targetPath);
    if (existing !== null) {
      throw new PathConflictError(targetPath, existing.type);
    }
  }

  /** Applies a fully validated move/rename (rewrites subtree paths for directories). */
  private async applyMove(
    workspaceId: string,
    node: FileNode,
    fromPath: string,
    targetPath: string,
  ): Promise<FileNode> {
    let parentId: string | null = null;
    const parent = parentPath(targetPath);
    if (parent !== null) {
      const parentNode = await this.files.getNode(workspaceId, parent);
      parentId = parentNode !== null ? parentNode.id : null;
    }
    const updated = await this.files.updateNode(workspaceId, node.id, {
      patch: { path: targetPath, name: baseName(targetPath), parentId },
      expectedRevision: node.revision,
      updatedAt: timestamp(this.now),
    });
    if (node.type === 'directory') {
      await this.files.moveSubtree(workspaceId, fromPath, targetPath, timestamp(this.now));
    }
    await this.bumpWorkspaceRevision(workspaceId);
    return updated;
  }

  // -----------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------

  /** Returns a node by path (must exist). */
  async getNode(workspaceId: string, rawPath: string): Promise<FileNode> {
    const path = this.normalizeNodePath(rawPath);
    return this.requireNode(workspaceId, path);
  }

  /**
   * Lists the children of a directory (`''`/root lists the top level).
   * Sorted by path. Directories must exist.
   */
  async listDirectory(workspaceId: string, rawPath: string): Promise<FileNode[]> {
    const path = rawPath === '' || rawPath === '/' ? ROOT_PATH : this.normalizeNodePath(rawPath);
    if (path !== ROOT_PATH) {
      const node = await this.requireNode(workspaceId, path);
      if (node.type !== 'directory') {
        throw new NodeOperationError(`"${path}" is a file, not a directory`, { path });
      }
    }
    return this.files.listChildren(workspaceId, path);
  }

  /** Returns every node in the workspace, sorted by path (tree reads). */
  async listAll(workspaceId: string): Promise<FileNode[]> {
    return this.files.listAll(workspaceId);
  }

  private async requireNode(workspaceId: string, path: string): Promise<FileNode> {
    const node = await this.files.getNode(workspaceId, path);
    if (node === null) {
      throw new FileNodeNotFoundError(path);
    }
    return node;
  }

  private validateContent(content: unknown): asserts content is string | undefined {
    if (content === undefined) return;
    if (typeof content !== 'string') {
      throw new NodeOperationError('file content must be a string');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new NodeOperationError(`file content must be at most ${MAX_FILE_BYTES} bytes`);
    }
  }
}

import { containsSecretShapedContent } from '../secrets/index.js';
import { VersionError } from '../errors/index.js';
import { ForeignProjectRevisionError } from '../errors/index.js';
import type { RestoreStep } from '../gateway/index.js';
import type { VersionControlManager } from '../manager/index.js';
import type { ProjectRevision } from '../types/index.js';
import {
  BranchArchivedError,
  BranchNameTakenError,
  BranchNotDeletableError,
  BranchNotFoundError,
  ForeignProjectBranchError,
} from './errors.js';
import type { BranchWorkspaceGateway } from './gateway.js';
import type { BranchStore } from './store.js';
import { BRANCH_LIMITS, type ActiveBranch, type Branch } from './types.js';

export interface BranchManagerOptions {
  readonly versions: VersionControlManager;
  readonly store: BranchStore;
  readonly workspaces: BranchWorkspaceGateway;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly createdBy?: string;
}

export interface CreateBranchInput {
  readonly projectId: string;
  readonly name: string;
  readonly description?: string | null;
  /** The branch to copy from. Required once the project has a branch. */
  readonly fromBranchId?: string;
  /** The revision to start from. Defaults to the source branch's latest. */
  readonly fromRevisionId?: string;
  readonly createdBy?: string;
}

export interface AdoptBranchInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name?: string;
  readonly createdBy?: string;
}

/**
 * Trims and bounds a name. Returns null when nothing usable is left.
 *
 * Control characters are checked on the RAW text. Collapsing whitespace first
 * would turn a newline or tab into a plain space and let it through unseen.
 */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const name = raw.trim().replace(/ {2,}/g, ' ');
  if (name === '' || name.length > BRANCH_LIMITS.maxNameLength) return null;
  return name;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Branches over Step 18's revisions.
 *
 * A branch OWNS a workspace, so its revisions (keyed by project and workspace)
 * are its own history, and a write to one branch cannot reach another. This
 * class stores no file content: it creates a workspace, fills it from a
 * revision through the integrity-checked snapshot, and records the name.
 */
export class BranchManager {
  private readonly versions: VersionControlManager;
  private readonly store: BranchStore;
  private readonly workspaces: BranchWorkspaceGateway;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly defaultCreatedBy: string;
  /** Serialises changes per project so two requests cannot race the same name. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: BranchManagerOptions) {
    this.versions = options.versions;
    this.store = options.store;
    this.workspaces = options.workspaces;
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ??
      (() =>
        globalThis.crypto?.randomUUID?.() ??
        `br_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    this.defaultCreatedBy = options.createdBy ?? 'api';
  }

  /** Runs `work` after any earlier change to the same project has finished. */
  private async exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.locks.set(
      projectId,
      run.catch(() => undefined),
    );
    return run;
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------

  async listBranches(
    projectId: string,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<Branch[]> {
    const all = await this.store.listBranches(projectId);
    return options.includeArchived === true ? all : all.filter((b) => b.state === 'active');
  }

  async getBranch(projectId: string, branchId: string): Promise<Branch> {
    const branch = await this.store.getBranch(branchId);
    if (branch === null) throw new BranchNotFoundError(branchId);
    // A branch of another project is reported as not found, not as forbidden:
    // the caller learns nothing about branches they do not own.
    if (branch.projectId !== projectId) throw new BranchNotFoundError(branchId);
    return branch;
  }

  async getActiveBranch(projectId: string): Promise<Branch | null> {
    const active = await this.store.getActive(projectId);
    if (active === null) return null;
    const branch = await this.store.getBranch(active.branchId);
    return branch !== null && branch.projectId === projectId ? branch : null;
  }

  // ------------------------------------------------------------------
  // First branch
  // ------------------------------------------------------------------

  /**
   * Makes an existing workspace the project's first branch.
   *
   * A project that predates branching already has a workspace and a history.
   * Adopting it keeps both: nothing is copied, and the existing revisions
   * become the default branch's history.
   */
  async adoptWorkspace(input: AdoptBranchInput): Promise<Branch> {
    return this.exclusive(input.projectId, async () => {
      const existing = await this.store.listBranches(input.projectId);
      const already = existing.find((b) => b.workspaceId === input.workspaceId);
      if (already !== undefined) return already;
      if (existing.length > 0) {
        throw new VersionError(
          'VERSION_INVALID_REQUEST',
          'This project already has branches; create a new one from an existing branch.',
        );
      }
      const name = cleanName(input.name ?? 'main');
      if (name === null) {
        throw new VersionError('VERSION_INVALID_REQUEST', 'The branch name is not valid.');
      }
      const at = this.now().toISOString();
      const latest = await this.versions.getLatestRevision(input.projectId, input.workspaceId);
      const branch: Branch = {
        id: this.generateId(),
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        name,
        description: null,
        state: 'active',
        isDefault: true,
        baseRevisionId: latest?.id ?? null,
        parentBranchId: null,
        createdAt: at,
        createdBy: input.createdBy ?? this.defaultCreatedBy,
        updatedAt: at,
        archivedAt: null,
      };
      await this.store.createBranch(branch);
      await this.store.setActive({
        projectId: input.projectId,
        branchId: branch.id,
        switchedAt: at,
        switchedBy: branch.createdBy,
      });
      return branch;
    });
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  async createBranch(input: CreateBranchInput): Promise<Branch> {
    return this.exclusive(input.projectId, async () => {
      const name = cleanName(input.name);
      if (name === null) {
        throw new VersionError(
          'VERSION_INVALID_REQUEST',
          `A branch name is required and can be at most ${BRANCH_LIMITS.maxNameLength} characters.`,
        );
      }
      if (containsSecretShapedContent(name)) {
        throw new VersionError('VERSION_SECRET_REJECTED', 'The branch name looks like a secret.');
      }
      const description =
        typeof input.description === 'string' && input.description.trim() !== ''
          ? input.description.trim().slice(0, BRANCH_LIMITS.maxDescriptionLength)
          : null;
      if (description !== null && containsSecretShapedContent(description)) {
        throw new VersionError(
          'VERSION_SECRET_REJECTED',
          'The branch description looks like a secret.',
        );
      }

      const existing = await this.store.listBranches(input.projectId);
      if (existing.some((b) => sameName(b.name, name))) throw new BranchNameTakenError(name);
      if (existing.length >= BRANCH_LIMITS.maxBranchesPerProject) {
        throw new VersionError(
          'VERSION_BRANCH_LIMIT',
          `A project can have at most ${BRANCH_LIMITS.maxBranchesPerProject} branches. Delete or archive one first.`,
        );
      }

      // Where to copy from.
      const source =
        input.fromBranchId !== undefined
          ? await this.getBranch(input.projectId, input.fromBranchId)
          : (existing.find((b) => b.isDefault) ?? existing[0]);
      if (source === undefined) {
        throw new VersionError(
          'VERSION_INVALID_REQUEST',
          'This project has no branch yet; adopt its workspace first.',
        );
      }
      if (source.state === 'archived') throw new BranchArchivedError(source.id);

      let base: ProjectRevision | null;
      if (input.fromRevisionId !== undefined) {
        base = await this.versions.getRevision(
          input.projectId,
          source.workspaceId,
          input.fromRevisionId,
        );
      } else {
        base = await this.versions.getLatestRevision(input.projectId, source.workspaceId);
      }
      if (base === null) {
        throw new VersionError(
          'VERSION_INVALID_REQUEST',
          'The source branch has no saved version to start from. Save a checkpoint first.',
        );
      }

      // Read the snapshot through the integrity check BEFORE touching anything.
      const snapshot = await this.versions.getIntactSnapshot(
        input.projectId,
        source.workspaceId,
        base.id,
      );
      const steps: RestoreStep[] = [];
      for (const node of [...snapshot.nodes].sort(
        (a, b) => a.path.split('/').length - b.path.split('/').length,
      )) {
        if (node.type === 'directory') steps.push({ kind: 'create_directory', path: node.path });
        else steps.push({ kind: 'create_file', path: node.path, content: node.content });
      }

      // Make and fill the workspace. If any step fails, remove what we made.
      const created = await this.workspaces.createWorkspace(input.projectId, name);
      try {
        await this.workspaces.seedWorkspace(created.workspaceId, steps);
        // The new branch starts with a first revision of its own, so it has a
        // history from the moment it exists.
        await this.versions.captureRevision({
          projectId: input.projectId,
          workspaceId: created.workspaceId,
          source: 'manual',
          message: `Branch "${name}" created from "${source.name}"`,
          createdBy: input.createdBy ?? this.defaultCreatedBy,
        });
      } catch (error) {
        await this.workspaces.discardWorkspace(created.workspaceId).catch(() => undefined);
        throw error instanceof VersionError
          ? error
          : new VersionError(
              'VERSION_BRANCH_WORKSPACE_FAILED',
              'The new branch could not be set up, so nothing was created.',
            );
      }

      const at = this.now().toISOString();
      const branch: Branch = {
        id: this.generateId(),
        projectId: input.projectId,
        workspaceId: created.workspaceId,
        name,
        description,
        state: 'active',
        isDefault: false,
        baseRevisionId: base.id,
        parentBranchId: source.id,
        createdAt: at,
        createdBy: input.createdBy ?? this.defaultCreatedBy,
        updatedAt: at,
        archivedAt: null,
      };
      await this.store.createBranch(branch);
      return branch;
    });
  }

  // ------------------------------------------------------------------
  // Rename, switch, archive, delete
  // ------------------------------------------------------------------

  async renameBranch(
    projectId: string,
    branchId: string,
    rawName: string,
    rawDescription?: string | null,
  ): Promise<Branch> {
    return this.exclusive(projectId, async () => {
      const branch = await this.getBranch(projectId, branchId);
      const name = cleanName(rawName);
      if (name === null) {
        throw new VersionError('VERSION_INVALID_REQUEST', 'The branch name is not valid.');
      }
      if (containsSecretShapedContent(name)) {
        throw new VersionError('VERSION_SECRET_REJECTED', 'The branch name looks like a secret.');
      }
      const others = await this.store.listBranches(projectId);
      if (others.some((b) => b.id !== branch.id && sameName(b.name, name))) {
        throw new BranchNameTakenError(name);
      }
      const description =
        rawDescription === undefined
          ? branch.description
          : typeof rawDescription === 'string' && rawDescription.trim() !== ''
            ? rawDescription.trim().slice(0, BRANCH_LIMITS.maxDescriptionLength)
            : null;
      if (description !== null && containsSecretShapedContent(description)) {
        throw new VersionError(
          'VERSION_SECRET_REJECTED',
          'The branch description looks like a secret.',
        );
      }
      const next: Branch = {
        ...branch,
        name,
        description,
        updatedAt: this.now().toISOString(),
      };
      await this.store.updateBranch(next);
      return next;
    });
  }

  /**
   * Makes a branch the one the project works on. Moves a pointer and nothing
   * else: no file is read, written or copied, so switching cannot lose work.
   */
  async switchBranch(projectId: string, branchId: string, by?: string): Promise<ActiveBranch> {
    return this.exclusive(projectId, async () => {
      const branch = await this.getBranch(projectId, branchId);
      if (branch.state === 'archived') throw new BranchArchivedError(branch.id);
      const active: ActiveBranch = {
        projectId,
        branchId: branch.id,
        switchedAt: this.now().toISOString(),
        switchedBy: by ?? this.defaultCreatedBy,
      };
      await this.store.setActive(active);
      return active;
    });
  }

  /**
   * Hides a branch without removing anything. Its workspace and every revision
   * stay, so it can be brought back. The branch in use cannot be archived.
   */
  async archiveBranch(projectId: string, branchId: string): Promise<Branch> {
    return this.exclusive(projectId, async () => {
      const branch = await this.getBranch(projectId, branchId);
      if (branch.state === 'archived') return branch;
      if (branch.isDefault) {
        throw new BranchNotDeletableError('The default branch cannot be archived.');
      }
      const active = await this.store.getActive(projectId);
      if (active?.branchId === branch.id) {
        throw new BranchNotDeletableError('Switch to another branch before archiving this one.');
      }
      const at = this.now().toISOString();
      const next: Branch = { ...branch, state: 'archived', archivedAt: at, updatedAt: at };
      await this.store.updateBranch(next);
      return next;
    });
  }

  async unarchiveBranch(projectId: string, branchId: string): Promise<Branch> {
    return this.exclusive(projectId, async () => {
      const branch = await this.getBranch(projectId, branchId);
      if (branch.state === 'active') return branch;
      const next: Branch = {
        ...branch,
        state: 'active',
        archivedAt: null,
        updatedAt: this.now().toISOString(),
      };
      await this.store.updateBranch(next);
      return next;
    });
  }

  /**
   * Whether a branch can be deleted, and if not, why. Used by the UI to explain
   * before the person tries.
   */
  async deletability(
    projectId: string,
    branchId: string,
  ): Promise<{ readonly deletable: boolean; readonly reason: string | null }> {
    const branch = await this.getBranch(projectId, branchId);
    if (branch.isDefault) {
      return { deletable: false, reason: 'The default branch cannot be deleted.' };
    }
    const active = await this.store.getActive(projectId);
    if (active?.branchId === branch.id) {
      return { deletable: false, reason: 'Switch to another branch before deleting this one.' };
    }
    const children = (await this.store.listBranches(projectId)).filter(
      (b) => b.parentBranchId === branch.id,
    );
    if (children.length > 0) {
      return {
        deletable: false,
        reason: `Other branches were created from this one (${children.map((c) => c.name).join(', ')}).`,
      };
    }
    return { deletable: true, reason: null };
  }

  /**
   * Deletes a branch record when that is safe.
   *
   * It removes the NAME. The branch's workspace and its revisions are left in
   * place, so nothing a person wrote is destroyed by this call; the workspace
   * simply stops being listed as a branch.
   */
  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const verdict = await this.deletability(projectId, branchId);
      if (!verdict.deletable) {
        throw new BranchNotDeletableError(verdict.reason ?? 'This branch cannot be deleted.');
      }
      await this.store.deleteBranch(branchId);
    });
  }

  /** The branch that owns a workspace, for labelling history. */
  async branchOfWorkspace(workspaceId: string): Promise<Branch | null> {
    return this.store.findByWorkspace(workspaceId);
  }

  /** Confirms a workspace belongs to the project's branches, or throws. */
  async requireProjectWorkspace(projectId: string, workspaceId: string): Promise<Branch> {
    const branch = await this.store.findByWorkspace(workspaceId);
    if (branch === null) throw new ForeignProjectBranchError();
    if (branch.projectId !== projectId) throw new ForeignProjectRevisionError();
    return branch;
  }
}

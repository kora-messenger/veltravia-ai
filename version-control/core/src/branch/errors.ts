import { VersionError } from '../errors/index.js';

/**
 * Branch failures reuse VersionError so the API maps every version-control
 * problem through one table. The codes are declared in errors/index.ts.
 */

export class BranchNotFoundError extends VersionError {
  constructor(branchId: string) {
    super('VERSION_BRANCH_NOT_FOUND', `Branch "${branchId}" was not found.`, { branchId });
  }
}

export class ForeignProjectBranchError extends VersionError {
  constructor() {
    super('VERSION_BRANCH_FOREIGN_PROJECT', 'The branch belongs to a different project.');
  }
}

export class BranchNameTakenError extends VersionError {
  constructor(name: string) {
    super('VERSION_BRANCH_NAME_TAKEN', `A branch named "${name}" already exists in this project.`, {
      name,
    });
  }
}

export class BranchArchivedError extends VersionError {
  constructor(branchId: string) {
    super('VERSION_BRANCH_ARCHIVED', 'The branch is archived. Restore it before using it.', {
      branchId,
    });
  }
}

export class BranchNotDeletableError extends VersionError {
  constructor(reason: string) {
    super('VERSION_BRANCH_NOT_DELETABLE', reason);
  }
}

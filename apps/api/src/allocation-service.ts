/**
 * Workspace credit allocation, as this server exposes it (Step 62).
 *
 * Two responsibilities, and nothing else:
 *
 *  - **Administration.** Reading the pool, granting an allowance to a member,
 *    project, agent or environment, raising or lowering it, reclaiming what was
 *    not spent, and recording the policy the workspace follows.
 *  - **The billing gate.** `authorize` is what `unified-billing` calls before a
 *    billable operation starts, and `settle`/`release` are what it calls when the
 *    operation finishes or gives up. Credit is reserved at authorisation time,
 *    inside the store's transaction, so two runs cannot both be told there is
 *    room for the last thousand credits.
 *
 * The workspace check lives here rather than in each route: a workspace id from
 * a request is resolved through the Project Engine and must belong to the caller,
 * so a forged id is a 404 and never a lookup in someone else's account.
 */

import {
  AllocationBook,
  AllocationError,
  InMemoryAllocationStore,
  platformAllocationLimits,
  type Allocation,
  type AllocationAuthorization,
  type AllocationEvent,
  type AllocationPolicyConfig,
  type AllocationPolicyName,
  type AllocationStore,
  type AllocationSummary,
  type AllocationTargetKind,
  type CreditCategory,
  type DistributionResult,
  type DistributionTarget,
  type WorkspacePool,
} from '@veltravia/allocation-core';
import type { ProjectEngine } from '@veltravia/project-core';

export interface AllocationServiceOptions {
  /** Durable store when the deployment has a database. */
  readonly store?: AllocationStore | undefined;
  /** Used to prove a workspace belongs to the caller before anything is read. */
  readonly projects: ProjectEngine;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface AllocationCapabilities {
  readonly durable: boolean;
  readonly categories: readonly CreditCategory[];
  readonly targets: readonly AllocationTargetKind[];
  readonly policies: readonly AllocationPolicyName[];
  readonly limits: {
    readonly maxPoolCredits: number;
    readonly maxAllocationCredits: number;
    readonly maxAllocationsPerWorkspace: number;
    readonly maxTargetSharePct: number;
  };
  readonly note: string;
}

export interface AllocationService {
  readonly durable: boolean;
  capabilities(): AllocationCapabilities;
  /** Refuses a workspace that does not belong to the caller. */
  owns(ownerRef: string, workspaceId: string): Promise<boolean>;
  summary(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
  }): Promise<AllocationSummary>;
  list(query: {
    readonly ownerRef: string;
    readonly workspaceId?: string | null;
    readonly category?: CreditCategory | null;
    readonly targetKind?: AllocationTargetKind | null;
    readonly targetRef?: string | null;
  }): Promise<readonly Allocation[]>;
  history(query: {
    readonly ownerRef: string;
    readonly workspaceId?: string | null;
    readonly category?: CreditCategory | null;
    readonly allocationId?: string | null;
    readonly limit?: number | null;
  }): Promise<readonly AllocationEvent[]>;
  get(ownerRef: string, allocationId: string): Promise<Allocation | null>;
  policy(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
  }): Promise<AllocationPolicyConfig>;
  setPolicy(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly defaultPolicy: AllocationPolicyName;
    readonly autoLimit: number;
    readonly maxTargetSharePct: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<AllocationPolicyConfig>;
  setPool(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly total: number;
    readonly note?: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<WorkspacePool>;
  allocate(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly targetKind: AllocationTargetKind;
    readonly targetRef: string;
    readonly amount: number;
    readonly limit?: number | null;
    readonly priority?: number;
    readonly policy?: AllocationPolicyName;
    readonly allowedOperations?: readonly string[];
    readonly expiresAt?: string | null;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation>;
  increase(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  reduce(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  reclaim(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  setLimit(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly limit: number | null;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  setPriority(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly priority: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  revoke(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation>;
  distribute(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly policy: AllocationPolicyName;
    readonly budget: number;
    readonly targets: readonly DistributionTarget[];
    readonly actor: string;
    readonly reason: string;
    readonly allowedOperations?: readonly string[];
    readonly expiresAt?: string | null;
  }): Promise<{ readonly planned: DistributionResult; readonly applied: readonly Allocation[] }>;
  /** The billing gate. Reserves credit or explains why it cannot. */
  authorize(input: {
    readonly ownerRef: string;
    readonly workspaceId: string | null;
    readonly category: CreditCategory;
    readonly amount: number;
    readonly operationKey: string;
    readonly operationKind: string | null;
    readonly projectId?: string | null;
    readonly agentRef?: string | null;
    readonly memberRef?: string | null;
  }): Promise<AllocationAuthorization>;
  settle(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly operationKey: string;
    readonly reason: string;
  }): Promise<void>;
  release(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly operationKey: string;
    readonly reason: string;
  }): Promise<void>;
  /** Releases the unspent part of every expired allowance. */
  sweep(ownerRef: string, workspaceId: string): Promise<number>;
}

export function createAllocationService(options: AllocationServiceOptions): AllocationService {
  const store: AllocationStore = options.store ?? new InMemoryAllocationStore();
  const platform = platformAllocationLimits(options.env ?? process.env);
  const book = new AllocationBook({
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
    platform,
  });
  const projects = options.projects;

  const owns = async (ownerRef: string, workspaceId: string): Promise<boolean> => {
    try {
      const workspace = await projects.workspaces.getWorkspace(workspaceId);
      const project = await projects.projects.getProject(workspace.projectId);
      return project.ownerRef === ownerRef && project.status !== 'deleted';
    } catch {
      return false;
    }
  };

  const requireWorkspace = async (ownerRef: string, workspaceId: string): Promise<void> => {
    if (!(await owns(ownerRef, workspaceId))) {
      throw new AllocationError('ALLOCATION_NOT_FOUND', 'That workspace was not found.', 404, {
        workspaceId,
      });
    }
  };

  /**
   * Allocation rows are checked one by one when a caller names an id: the row
   * must belong to the caller and its workspace must still be theirs. A row whose
   * workspace was deleted is treated as missing rather than reachable.
   */
  const requireAllocation = async (ownerRef: string, allocationId: string): Promise<Allocation> => {
    const allocation = await book.get(ownerRef, allocationId);
    if (allocation === null) {
      throw new AllocationError('ALLOCATION_NOT_FOUND', 'That allocation was not found.', 404, {
        allocationId,
      });
    }
    await requireWorkspace(ownerRef, allocation.workspaceId);
    return allocation;
  };

  return {
    durable: options.store !== undefined,

    capabilities() {
      return {
        durable: options.store !== undefined,
        categories: ['ai_tokens', 'integration_credits'],
        targets: ['member', 'project', 'agent', 'environment'],
        policies: [
          'manual',
          'equal',
          'project',
          'member',
          'priority',
          'restricted',
          'temporary',
          'automatic',
        ],
        limits: platform,
        note: 'An allocation is a ceiling over the workspace wallet, never a second balance. The two credit categories are separate and are never converted into each other.',
      };
    },

    owns,

    async summary(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.summary(input);
    },

    async list(query) {
      if (query.workspaceId != null) await requireWorkspace(query.ownerRef, query.workspaceId);
      return book.list(query);
    },

    async history(query) {
      if (query.workspaceId != null) await requireWorkspace(query.ownerRef, query.workspaceId);
      return book.history(query);
    },

    async get(ownerRef, allocationId) {
      return book.get(ownerRef, allocationId);
    },

    async policy(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.policy(input.ownerRef, input.workspaceId, input.category);
    },

    async setPolicy(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.setPolicy(input);
    },

    async setPool(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.setPool(input);
    },

    async allocate(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.allocate(input);
    },

    async increase(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.increase(input);
    },

    async reduce(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.reduce(input);
    },

    async reclaim(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.reclaim(input);
    },

    async setLimit(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.setLimit(input);
    },

    async setPriority(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.setPriority(input);
    },

    async revoke(input) {
      await requireAllocation(input.ownerRef, input.allocationId);
      return book.revoke(input);
    },

    async distribute(input) {
      await requireWorkspace(input.ownerRef, input.workspaceId);
      return book.distribute(input);
    },

    /**
     * The gate. With no workspace in scope there is no workspace pool to consult,
     * so the answer is "allowed" and the wallet remains the only check. That is
     * the same behaviour the product had before this step.
     */
    async authorize(input) {
      if (input.workspaceId === null || input.workspaceId === undefined) {
        return {
          allowed: true,
          allocationId: null,
          targetKind: null,
          targetRef: null,
          amount: input.amount,
          available: null,
          code: null,
          reason:
            'This operation is not attached to a workspace, so the workspace wallet is the only check.',
          operationKey: null,
        };
      }
      return book.authorize({
        ownerRef: input.ownerRef,
        workspaceId: input.workspaceId,
        category: input.category,
        amount: input.amount,
        operationKey: input.operationKey,
        operationKind: input.operationKind,
        projectId: input.projectId ?? null,
        agentRef: input.agentRef ?? null,
        memberRef: input.memberRef ?? null,
        actor: 'billing',
      });
    },

    async settle(input) {
      await book
        .settle({
          ownerRef: input.ownerRef,
          allocationId: input.allocationId,
          amount: input.amount,
          operationKey: input.operationKey,
          actor: 'billing',
          reason: input.reason,
        })
        .catch((error: unknown) => {
          // Settlement runs after the work is done and the wallet has already been
          // charged. A failure here must not turn finished work into an error; it
          // is logged so the allocation can be reconciled.
          if (!(error instanceof AllocationError)) throw error;
          console.warn(
            `[allocations] settlement failed for ${input.operationKey}: ${error.code} ${error.message}`,
          );
        });
    },

    async release(input) {
      await book
        .release({
          ownerRef: input.ownerRef,
          allocationId: input.allocationId,
          amount: input.amount,
          operationKey: input.operationKey,
          actor: 'billing',
          reason: input.reason,
        })
        .catch((error: unknown) => {
          if (!(error instanceof AllocationError)) throw error;
          console.warn(
            `[allocations] release failed for ${input.operationKey}: ${error.code} ${error.message}`,
          );
        });
    },

    async sweep(ownerRef, workspaceId) {
      return book.sweepExpired(ownerRef, workspaceId);
    },
  };
}

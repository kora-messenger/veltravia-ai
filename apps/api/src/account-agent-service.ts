/**
 * The Personal Account Agent, as this server assembles it (Step 62).
 *
 * Every tool below is a thin adapter over a service that already exists and
 * already enforces ownership: the Project Engine for projects, workspaces and
 * files, the wallet and both charge lanes for credit, the subscription and
 * payment services for the plan and the bills, and the allocation service for
 * budgets. Nothing here reads the database directly, holds a provider key, or
 * accepts an account id from the request.
 *
 * Three honest rules the implementation follows:
 *
 *  - **Identity is the session.** `ownerRef` comes from `AccountPrincipal`; a tool
 *    that needs to check a resource looks the resource up and compares its owner.
 *  - **An operation that does not exist is declared unavailable, with a reason.**
 *    Workspace membership is not part of this build, so "invite a member" says so
 *    instead of returning a cheerful fake success.
 *  - **A write reports what changed.** The result names the resource id and where
 *    it lives, so the interface can show it and the audit row can prove it.
 */

import {
  AccountAgent,
  AccountToolRegistry,
  InMemoryAccountActionStore,
  type AccountActionStore,
  type AccountAuditEntry,
  type AccountAuditQuery,
  type AccountCallOutcome,
  type AccountCallRequest,
  type AccountPermission,
  type AccountPrincipal,
  type AccountTool,
  type AccountToolDefinition,
  type AccountToolResult,
  type ParamSpec,
} from '@veltravia/account-agent-core';
import type { ProjectEngine } from '@veltravia/project-core';

import type { AllocationService } from './allocation-service.js';
import type { IntegrationCreditService } from './integration-credit-service.js';
import type { MessageCreditService } from './message-credit-service.js';
import type { PaymentService } from './payment-service.js';
import type { SubscriptionService } from './subscription-service.js';
import type { TaskService } from './task-service.js';
import type { WalletService } from './wallet-service.js';

export interface AccountAgentServiceOptions {
  readonly projects: ProjectEngine;
  readonly wallet: WalletService;
  readonly messageCredits: MessageCreditService;
  readonly integrationCredits: IntegrationCreditService;
  readonly subscriptions: SubscriptionService;
  readonly payments: PaymentService;
  readonly allocations: AllocationService;
  readonly tasks?: TaskService | undefined;
  readonly store?: AccountActionStore | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface AccountCatalog {
  readonly durable: boolean;
  readonly tools: readonly AccountToolDefinition[];
  readonly permissions: readonly AccountPermission[];
  readonly note: string;
}

export interface AccountAgentService {
  readonly durable: boolean;
  catalog(principal: AccountPrincipal): AccountCatalog;
  call(principal: AccountPrincipal, request: AccountCallRequest): Promise<AccountCallOutcome>;
  activity(
    principal: AccountPrincipal,
    query?: Omit<AccountAuditQuery, 'ownerRef'>,
  ): Promise<readonly AccountAuditEntry[]>;
  entry(principal: AccountPrincipal, entryId: string): Promise<AccountAuditEntry | null>;
}

const PROJECT_TYPES = ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'] as const;

/** Trims anything long enough to break a log line or a card. */
const short = (value: string, max = 120): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function createAccountAgentService(
  options: AccountAgentServiceOptions,
): AccountAgentService {
  const { projects, allocations } = options;
  const store: AccountActionStore = options.store ?? new InMemoryAccountActionStore();
  const registry = new AccountToolRegistry();

  const read = (
    name: string,
    title: string,
    summary: string,
    params: readonly ParamSpec[],
    run: AccountTool['invoke'],
    extra: Partial<AccountToolDefinition> = {},
  ): AccountTool => ({
    definition: {
      name,
      title,
      summary,
      risk: 1,
      permission: 'account:read',
      params,
      mutates: false,
      availability: { available: true },
      needsWorkspace: false,
      ...extra,
    },
    invoke: run,
  });

  const write = (
    name: string,
    title: string,
    summary: string,
    params: readonly ParamSpec[],
    risk: 2 | 3 | 4,
    permission: AccountPermission,
    run: AccountTool['invoke'],
    extra: Partial<AccountToolDefinition> = {},
  ): AccountTool => ({
    definition: {
      name,
      title,
      summary,
      risk,
      permission,
      params,
      mutates: true,
      availability: { available: true },
      needsWorkspace: false,
      ...extra,
    },
    invoke: run,
  });

  const unavailable = (
    name: string,
    title: string,
    summary: string,
    risk: 2 | 3 | 4,
    permission: AccountPermission,
    reason: string,
  ): AccountTool => ({
    definition: {
      name,
      title,
      summary,
      risk,
      permission,
      params: [],
      mutates: true,
      availability: { available: false, reason },
      needsWorkspace: false,
    },
    async invoke() {
      return {
        ok: false,
        summary: reason,
        failure: { code: 'TOOL_NOT_AVAILABLE', message: reason },
      };
    },
  });

  /** Loads a project the caller owns, or fails with a plain answer. */
  const ownedProject = async (principal: AccountPrincipal, projectId: string) => {
    const project = await projects.projects.getProject(projectId).catch(() => null);
    if (
      project === null ||
      project.ownerRef !== principal.ownerRef ||
      project.status === 'deleted'
    ) {
      return null;
    }
    return project;
  };

  const ownedWorkspace = async (principal: AccountPrincipal, workspaceId: string) => {
    const workspace = await projects.workspaces.getWorkspace(workspaceId).catch(() => null);
    if (workspace === null) return null;
    const project = await ownedProject(principal, workspace.projectId);
    return project === null ? null : workspace;
  };

  const notFound = (resource: string, id: string): AccountToolResult => ({
    ok: false,
    summary: `That ${resource} was not found in your account.`,
    failure: { code: 'NOT_FOUND', message: `${resource} ${id} was not found.` },
  });

  registry.registerAll([
    read(
      'account.summary',
      'Account summary',
      'Reads the plan in force, the wallet balance and both credit balances for this account.',
      [],
      async ({ principal }) => {
        const [plan, wallet, messages, integration] = await Promise.all([
          options.subscriptions.effective(principal.ownerRef),
          options.wallet
            .ensure({ ownerRef: principal.ownerRef })
            .then(() => options.wallet.overview({ ownerRef: principal.ownerRef })),
          options.messageCredits.summary({ ownerRef: principal.ownerRef }),
          options.integrationCredits.summary({ ownerRef: principal.ownerRef }),
        ]);
        return {
          ok: true,
          summary: `You are on the ${plan.plan.name} plan with ${wallet.wallet.available} credits available.`,
          data: { plan, wallet: wallet.wallet, messages, integration },
        };
      },
    ),

    read(
      'credits.balances',
      'Credit balances',
      'Reads the AI token credits and integration credits that are available, held and spent.',
      [],
      async ({ principal }) => {
        const [messages, integration] = await Promise.all([
          options.messageCredits.summary({ ownerRef: principal.ownerRef }),
          options.integrationCredits.summary({ ownerRef: principal.ownerRef }),
        ]);
        return {
          ok: true,
          summary: 'Here are your AI token and integration credit balances.',
          data: { aiTokens: messages, integrationCredits: integration },
        };
      },
    ),

    read(
      'subscription.status',
      'Subscription',
      'Reads the plan in force, its period, renewal date and status.',
      [],
      async ({ principal }) => {
        const overview = await options.subscriptions.overview(principal.ownerRef);
        return {
          ok: true,
          summary:
            overview.subscription === null
              ? 'There is no paid subscription on this account; the included allowance applies.'
              : `The ${overview.effective.plan.name} plan is ${overview.status} with ${overview.daysRemaining} days remaining.`,
          data: overview,
        };
      },
    ),

    read(
      'billing.history',
      'Billing history',
      'Reads invoices, payments and the payment methods on file.',
      [{ name: 'limit', type: 'number', integer: true, minimum: 1, maximum: 50 }],
      async ({ principal, args }) => {
        const overview = await options.payments.overview(principal.ownerRef);
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;
        return {
          ok: true,
          summary: 'Here is the billing history on file for this account.',
          data: {
            invoices: (overview.invoices ?? []).slice(0, limit),
            transactions: (overview.transactions ?? []).slice(0, limit),
            paymentMethod: overview.paymentMethod,
            plan: overview.plan,
            periodEnd: overview.plan.currentPeriodEnd,
          },
        };
      },
    ),

    read(
      'project.list',
      'List projects',
      'Lists the projects in this account with their status and workspace count.',
      [{ name: 'includeArchived', type: 'boolean' }],
      async ({ principal, args }) => {
        const all = await projects.projects.listProjects({ ownerRef: principal.ownerRef });
        const includeArchived = args['includeArchived'] === true;
        const visible = all.filter(
          (project) =>
            project.status !== 'deleted' && (includeArchived || project.status === 'active'),
        );
        return {
          ok: true,
          summary:
            visible.length === 0
              ? 'There are no projects yet.'
              : `You have ${visible.length} project${visible.length === 1 ? '' : 's'}.`,
          data: visible.map((project) => ({
            id: project.id,
            name: project.name,
            status: project.status,
            projectType: project.projectType,
            updatedAt: project.updatedAt,
          })),
        };
      },
    ),

    read(
      'project.get',
      'Project details',
      'Reads one project, its workspaces and its file count.',
      [{ name: 'projectId', type: 'string', required: true }],
      async ({ principal, args }) => {
        const projectId = String(args['projectId']);
        const project = await ownedProject(principal, projectId);
        if (project === null) return notFound('project', projectId);
        const workspaces = await projects.workspaces.listWorkspaces(projectId);
        let files = 0;
        for (const workspace of workspaces) {
          files += (await projects.files.listAll(workspace.id)).filter(
            (node) => node.type === 'file',
          ).length;
        }
        return {
          ok: true,
          summary: `${project.name} is ${project.status} with ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} and ${files} file${files === 1 ? '' : 's'}.`,
          data: {
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              status: project.status,
              projectType: project.projectType,
              revision: project.revision,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            },
            workspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
              status: workspace.status,
            })),
            files,
          },
        };
      },
    ),

    read(
      'file.list',
      'List files',
      'Lists the folders and files in one workspace.',
      [{ name: 'workspaceId', type: 'string', required: true }],
      async ({ principal, args }) => {
        const workspaceId = String(args['workspaceId']);
        const workspace = await ownedWorkspace(principal, workspaceId);
        if (workspace === null) return notFound('workspace', workspaceId);
        const nodes = await projects.files.listAll(workspaceId);
        return {
          ok: true,
          summary:
            nodes.length === 0
              ? 'That workspace has no files yet.'
              : `That workspace holds ${nodes.length} item${nodes.length === 1 ? '' : 's'}.`,
          data: nodes.slice(0, 200).map((node) => ({
            path: node.path,
            type: node.type,
            size: node.size,
          })),
        };
      },
    ),

    read(
      'tasks.list',
      'Tasks',
      'Lists the agent tasks recorded for this account, newest first.',
      [
        { name: 'status', type: 'string' },
        { name: 'limit', type: 'number', integer: true, maximum: 50 },
      ],
      async ({ principal, args }) => {
        if (options.tasks === undefined) {
          return {
            ok: false,
            summary: 'Task history is not available on this deployment.',
            failure: { code: 'TOOL_NOT_AVAILABLE', message: 'No task service is configured.' },
          };
        }
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;
        const rows = await options.tasks.manager.listTasks(principal.ownerRef, { limit });
        const status = typeof args['status'] === 'string' ? args['status'] : null;
        const filtered = status === null ? rows : rows.filter((task) => task.status === status);
        return {
          ok: true,
          summary:
            filtered.length === 0
              ? 'There are no tasks matching that.'
              : `There ${filtered.length === 1 ? 'is' : 'are'} ${filtered.length} matching task${filtered.length === 1 ? '' : 's'}.`,
          data: filtered.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            projectId: task.projectId,
            updatedAt: task.updatedAt,
          })),
        };
      },
    ),

    read(
      'allocation.summary',
      'Credit allocation',
      'Reads how this workspace has split its AI token and integration credits.',
      [{ name: 'workspaceId', type: 'string', required: true }],
      async ({ principal, args }) => {
        const workspaceId = String(args['workspaceId']);
        const summary = await allocations.summary({ ownerRef: principal.ownerRef, workspaceId });
        const ai = summary.categories.find((entry) => entry.category === 'ai_tokens');
        return {
          ok: true,
          summary:
            ai === undefined || !ai.pool.set
              ? 'This workspace has not set an allocation pool yet, so credit is checked against the workspace balance only.'
              : `The workspace has allocated ${ai.pool.allocated} of ${ai.pool.total} AI credits, leaving ${ai.pool.available} unallocated.`,
          data: summary,
        };
      },
    ),

    read(
      'activity.list',
      'What the assistant did',
      'Lists the account actions the assistant performed, was refused, or is waiting to confirm.',
      [{ name: 'limit', type: 'number', integer: true, maximum: 50 }],
      async ({ principal, args }) => {
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;
        const rows = await store.list({ ownerRef: principal.ownerRef, limit });
        return {
          ok: true,
          summary:
            rows.length === 0
              ? 'The assistant has not performed any account actions yet.'
              : `Here are the last ${rows.length} account actions.`,
          data: rows.map((row) => ({
            id: row.id,
            tool: row.tool,
            status: row.status,
            summary: row.resultSummary,
            occurredAt: row.occurredAt,
          })),
        };
      },
    ),

    read(
      'account.search',
      'Search',
      'Searches projects, workspaces and files in this account by name.',
      [{ name: 'query', type: 'string', required: true, maxLength: 120 }],
      async ({ principal, args }) => {
        const query = String(args['query']).toLowerCase();
        const matches: { type: string; id: string; name: string; location?: string }[] = [];
        const all = await projects.projects.listProjects({ ownerRef: principal.ownerRef });
        for (const project of all) {
          if (project.status === 'deleted') continue;
          if (project.name.toLowerCase().includes(query)) {
            matches.push({ type: 'project', id: project.id, name: project.name });
            continue;
          }
          const workspaces = await projects.workspaces.listWorkspaces(project.id);
          for (const workspace of workspaces) {
            if (workspace.name.toLowerCase().includes(query)) {
              matches.push({
                type: 'workspace',
                id: workspace.id,
                name: workspace.name,
                location: project.name,
              });
            }
            const nodes = await projects.files.listAll(workspace.id);
            for (const node of nodes) {
              if (node.path.toLowerCase().includes(query)) {
                matches.push({
                  type: node.type,
                  id: `${workspace.id}:${node.path}`,
                  name: node.path,
                  location: `${project.name} / ${workspace.name}`,
                });
              }
              if (matches.length >= 40) break;
            }
          }
        }
        return {
          ok: true,
          summary:
            matches.length === 0
              ? `Nothing matched "${short(query)}".`
              : `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${short(query)}".`,
          data: matches.slice(0, 40),
        };
      },
    ),

    write(
      'project.create',
      'Create a project',
      'Creates a new project in this account and returns where it lives.',
      [
        { name: 'name', type: 'string', required: true, maxLength: 120 },
        { name: 'description', type: 'string', maxLength: 400 },
        { name: 'projectType', type: 'enum', values: PROJECT_TYPES },
      ],
      2,
      'account:write',
      async ({ principal, args }) => {
        const project = await projects.projects.createProject({
          name: String(args['name']),
          description:
            typeof args['description'] === 'string'
              ? args['description']
              : 'Created by the assistant.',
          projectType:
            typeof args['projectType'] === 'string'
              ? (args['projectType'] as (typeof PROJECT_TYPES)[number])
              : 'other',
          ownerRef: principal.ownerRef,
        });
        const workspaces = await projects.workspaces.listWorkspaces(project.id);
        return {
          ok: true,
          summary: `Created the project "${project.name}".`,
          data: {
            id: project.id,
            name: project.name,
            workspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
            })),
          },
          changed: [{ resource: 'project', id: project.id, location: project.name }],
        };
      },
    ),

    write(
      'project.update',
      'Rename or describe a project',
      'Changes a project’s name or description. The current revision is used, so a concurrent change is reported rather than overwritten.',
      [
        { name: 'projectId', type: 'string', required: true },
        { name: 'name', type: 'string', maxLength: 120 },
        { name: 'description', type: 'string', maxLength: 400 },
      ],
      2,
      'account:write',
      async ({ principal, args }) => {
        const projectId = String(args['projectId']);
        const project = await ownedProject(principal, projectId);
        if (project === null) return notFound('project', projectId);
        const patch: { name?: string; description?: string } = {};
        if (typeof args['name'] === 'string') patch.name = args['name'];
        if (typeof args['description'] === 'string') patch.description = args['description'];
        if (Object.keys(patch).length === 0) {
          return {
            ok: false,
            summary: 'Nothing was changed: name a new name or description.',
            failure: { code: 'INVALID_ARGUMENTS', message: 'No change was requested.' },
          };
        }
        const updated = await projects.projects.updateProject(projectId, patch, project.revision);
        return {
          ok: true,
          summary: `Updated the project "${updated.name}".`,
          data: { id: updated.id, name: updated.name, description: updated.description },
          changed: [{ resource: 'project', id: updated.id, location: updated.name }],
        };
      },
    ),

    write(
      'workspace.rename',
      'Rename a workspace',
      'Renames one workspace inside a project you own.',
      [
        { name: 'workspaceId', type: 'string', required: true },
        { name: 'name', type: 'string', required: true, maxLength: 120 },
      ],
      3,
      'workspace:admin',
      async ({ principal, args }) => {
        const workspaceId = String(args['workspaceId']);
        const workspace = await ownedWorkspace(principal, workspaceId);
        if (workspace === null) return notFound('workspace', workspaceId);
        const updated = await projects.workspaces.updateWorkspace(
          workspaceId,
          { name: String(args['name']) },
          workspace.revision,
        );
        return {
          ok: true,
          summary: `Renamed the workspace to "${updated.name}".`,
          data: { id: updated.id, name: updated.name },
          changed: [{ resource: 'workspace', id: updated.id, location: updated.name }],
        };
      },
    ),

    write(
      'file.create_directory',
      'Create a folder',
      'Creates a folder in one workspace.',
      [
        { name: 'workspaceId', type: 'string', required: true },
        { name: 'path', type: 'string', required: true, maxLength: 300 },
      ],
      2,
      'account:write',
      async ({ principal, args }) => {
        const workspaceId = String(args['workspaceId']);
        const workspace = await ownedWorkspace(principal, workspaceId);
        if (workspace === null) return notFound('workspace', workspaceId);
        const node = await projects.files.createDirectory(workspaceId, String(args['path']));
        return {
          ok: true,
          summary: `Created the folder ${node.path}.`,
          data: { path: node.path, type: node.type },
          changed: [
            { resource: 'directory', id: `${workspaceId}:${node.path}`, location: node.path },
          ],
        };
      },
    ),

    write(
      'allocation.allocate',
      'Allocate credits',
      'Sets aside part of a workspace’s credit pool for a project, member, agent or environment.',
      [
        { name: 'workspaceId', type: 'string', required: true },
        {
          name: 'category',
          type: 'enum',
          required: true,
          values: ['ai_tokens', 'integration_credits'],
        },
        {
          name: 'targetKind',
          type: 'enum',
          required: true,
          values: ['member', 'project', 'agent', 'environment'],
        },
        { name: 'targetRef', type: 'string', required: true, maxLength: 200 },
        { name: 'amount', type: 'number', required: true, minimum: 0.0001, maximum: 1_000_000 },
      ],
      3,
      'workspace:admin',
      async ({ principal, args }) => {
        const allocation = await allocations.allocate({
          ownerRef: principal.ownerRef,
          workspaceId: String(args['workspaceId']),
          category: args['category'] as 'ai_tokens' | 'integration_credits',
          targetKind: args['targetKind'] as 'member' | 'project' | 'agent' | 'environment',
          targetRef: String(args['targetRef']),
          amount: Number(args['amount']),
          actor: principal.ownerRef,
          reason: 'Requested through the assistant',
        });
        return {
          ok: true,
          summary: `Allocated ${allocation.allocated} credits to that ${allocation.targetKind}.`,
          data: { allocation },
          changed: [
            { resource: 'allocation', id: allocation.id, location: allocation.workspaceId },
          ],
        };
      },
    ),

    write(
      'allocation.increase',
      'Increase an allocation',
      'Raises an existing allocation from the same workspace pool.',
      [
        { name: 'allocationId', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true, minimum: 0.0001, maximum: 1_000_000 },
      ],
      3,
      'workspace:admin',
      async ({ principal, args }) => {
        const allocation = await allocations.increase({
          ownerRef: principal.ownerRef,
          allocationId: String(args['allocationId']),
          amount: Number(args['amount']),
          actor: principal.ownerRef,
          reason: 'Requested through the assistant',
        });
        return {
          ok: true,
          summary: `That allocation now holds ${allocation.allocated} credits.`,
          data: { allocation },
          changed: [
            { resource: 'allocation', id: allocation.id, location: allocation.workspaceId },
          ],
        };
      },
    ),

    write(
      'allocation.reduce',
      'Reduce an allocation',
      'Takes unspent credit back from an allocation. Credit already spent or held cannot be taken back.',
      [
        { name: 'allocationId', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true, minimum: 0.0001, maximum: 1_000_000 },
      ],
      3,
      'workspace:admin',
      async ({ principal, args }) => {
        const allocation = await allocations.reduce({
          ownerRef: principal.ownerRef,
          allocationId: String(args['allocationId']),
          amount: Number(args['amount']),
          actor: principal.ownerRef,
          reason: 'Requested through the assistant',
        });
        return {
          ok: true,
          summary: `That allocation now holds ${allocation.allocated} credits.`,
          data: { allocation },
          changed: [
            { resource: 'allocation', id: allocation.id, location: allocation.workspaceId },
          ],
        };
      },
    ),

    write(
      'project.delete',
      'Delete a project',
      'Deletes a project you own. This needs the workspace owner and a confirmation, because it cannot be undone from here.',
      [{ name: 'projectId', type: 'string', required: true }],
      4,
      'workspace:owner',
      async ({ principal, args }) => {
        const projectId = String(args['projectId']);
        const project = await ownedProject(principal, projectId);
        if (project === null) return notFound('project', projectId);
        const deleted = await projects.projects.deleteProject(projectId);
        return {
          ok: true,
          summary: `Deleted the project "${project.name}".`,
          data: { id: deleted.id, status: deleted.status },
          changed: [
            { resource: 'project', id: deleted.id, location: projectedLocation(project.name) },
          ],
        };
      },
    ),

    unavailable(
      'member.invite',
      'Invite a team member',
      'Invites somebody to this workspace.',
      3,
      'workspace:admin',
      'This build has no workspace membership yet, so there is nobody to invite and no invitation to send. The operation is listed here rather than offered as a button that does nothing.',
    ),

    unavailable(
      'integration.connect',
      'Connect an external account',
      'Connects a third-party account to this workspace.',
      3,
      'workspace:admin',
      'Connecting an account needs an OAuth consent screen only a person can complete. Use Connections in the app, where the provider’s own sign-in flow runs.',
    ),
  ]);

  const agent = new AccountAgent({
    registry,
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    durable: options.store !== undefined,

    catalog(principal) {
      return {
        durable: options.store !== undefined,
        tools: agent.catalog(),
        permissions: agent.permissionsFor(principal),
        note: 'Every operation below is declared on the server. Read-only work runs straight away; a reversible change runs under your own permissions; a sensitive or high-impact action asks you to confirm it first.',
      };
    },

    call: (principal, request) => agent.call(principal, request),

    activity: (principal, query) => agent.history(principal, query ?? {}),

    entry: (principal, entryId) => agent.entry(principal, entryId),
  };
}

/** Deleting a project keeps its name in the audit trail, not its path. */
function projectedLocation(name: string): string {
  return name;
}

import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';
import type {
  AccountPrincipal,
  AccountToolDefinition,
  ParamSpec,
} from '@veltravia/account-agent-core';

import type { AccountAgentService } from './account-agent-service.js';

/**
 * Account operations as tools the chat's model can actually call (Step 62).
 *
 * Without this file the account agent existed only behind `/api/account/...`:
 * a person could type "how many credits do I have left" in the chat and get
 * prose, because the model had no way to read the account. Every tool here is
 * declared in the same tool system as the rest of the platform, so it inherits
 * the same three things for free:
 *
 *   - the schema check on the arguments before anything runs;
 *   - the human confirmation for a risky action, bound to the exact input;
 *   - an audit row for the refusal as well as the run.
 *
 * The owner is bound by the caller, never by the model: `principal` is built
 * from the request's session in the route, and no argument can name another
 * account (the account agent refuses identity-shaped arguments itself).
 *
 * A tool this deployment cannot perform (inviting a member, connecting an
 * external account) is still listed, and disabled with its reason, so the model
 * can say what is missing instead of inventing a success.
 */

/** Risk in the account agent's 1-4 scale, in the tool system's own words. */
function riskLevelOf(risk: number): 'low' | 'medium' | 'high' | 'critical' {
  if (risk >= 4) return 'critical';
  if (risk === 3) return 'high';
  if (risk === 2) return 'medium';
  return 'low';
}

/**
 * Permission ids are dot-separated lowercase (`account.read`), so the account
 * agent's `account:read` becomes `account.read` here. The mapping is written
 * out rather than derived by replacing characters, so a new account permission
 * cannot silently collide with an existing tool permission.
 */
const TOOL_PERMISSION: Readonly<Record<string, string>> = {
  'account:read': 'account.read',
  'account:write': 'account.write',
  'workspace:admin': 'account.workspace-admin',
  'workspace:owner': 'account.workspace-owner',
};

function permissionOf(permission: string): string {
  const mapped = TOOL_PERMISSION[permission];
  if (mapped === undefined) {
    // A permission this file has never seen would otherwise be granted under a
    // guessed id; failing loudly is the honest answer.
    throw new Error(`Unmapped account permission "${permission}"`);
  }
  return mapped;
}

/** One declared argument as a JSON-schema property. */
function propertyOf(param: ParamSpec): Record<string, unknown> {
  const description = param.description ?? param.name;
  switch (param.type) {
    case 'string':
      return {
        type: 'string',
        description,
        ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}),
      };
    case 'number':
      return {
        type: 'number',
        description,
        ...(param.minimum !== undefined ? { minimum: param.minimum } : {}),
        ...(param.maximum !== undefined ? { maximum: param.maximum } : {}),
      };
    case 'boolean':
      return { type: 'boolean', description };
    case 'enum':
      return { type: 'string', description, enum: [...(param.values ?? [])] };
    case 'string_list':
      return {
        type: 'array',
        description,
        items: { type: 'string' },
        ...(param.maxItems !== undefined ? { maxItems: param.maxItems } : {}),
      };
  }
}

function inputSchemaOf(tool: AccountToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of tool.params) {
    properties[param.name] = propertyOf(param);
    if (param.required === true) required.push(param.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export interface AccountToolBundle {
  readonly definitions: readonly ToolDefinition[];
  readonly implementations: readonly ToolImplementation[];
  /** Tools that exist but cannot run here, with the manager's disable reason. */
  readonly disabled: readonly { readonly id: string; readonly reason: string }[];
}

export function createAccountTools(
  accounts: AccountAgentService,
  principal: AccountPrincipal,
): AccountToolBundle {
  const catalog = accounts.catalog(principal);
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];
  const disabled: { id: string; reason: string }[] = [];

  for (const tool of catalog.tools) {
    // The account agent already names its tools in this namespace
    // ("account.summary"), so those keep their name instead of doubling it.
    const id = tool.name.startsWith('account.') ? tool.name : `account.${tool.name}`;
    const unavailable = !tool.availability.available;
    const reason =
      tool.availability.reason ?? 'That operation is not available on this deployment.';
    definitions.push(
      defineTool({
        id,
        name: tool.title,
        description: unavailable ? `${tool.summary} Not available here: ${reason}` : tool.summary,
        version: '0.1.0',
        category: tool.mutates ? 'system' : 'data',
        inputSchema: inputSchemaOf(tool) as never,
        /*
         * The model reads `summary` and, when the tool returns facts, `detail`
         * as JSON. Keeping the detail a string means an unbounded result shape
         * cannot fail the output schema and turn a real answer into an error.
         */
        outputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'executed, replayed, refused or failed.',
            },
            ok: { type: 'boolean', description: 'False when the account refused the action.' },
            summary: { type: 'string', description: 'What happened, in one plain sentence.' },
            detail: {
              type: 'string',
              description: 'JSON detail the tool returned, when there is any. Empty otherwise.',
            },
          },
          required: ['status', 'ok', 'summary', 'detail'],
          additionalProperties: false,
        } as never,
        requiredPermissions: [permissionOf(tool.permission)],
        riskLevel: riskLevelOf(tool.risk),
        // The account agent already demands a confirmation for risk 3 and 4;
        // saying so here means the person gives it once, in the chat, against
        // the exact arguments, and the call then carries that decision.
        requiresConfirmation: tool.risk >= 3,
      }),
    );

    implementations.push({
      toolId: id,
      handler: async (input, context) => {
        const confirmationId = context.invocation.confirmationId;
        const grant =
          confirmationId === undefined
            ? null
            : ({ kind: 'tool_confirmation', reference: confirmationId } as const);
        const outcome = await accounts.call(principal, {
          tool: tool.name,
          args: input,
          idempotencyKey: context.invocation.id,
          grant,
          executionId: context.invocation.correlationId ?? null,
        });
        if (outcome.status === 'refused' || outcome.status === 'failed') {
          /*
           * A refusal is reported to the model as the refusal it is, with the
           * account's own sentence. Throwing keeps it out of the "succeeded"
           * path: the assistant must not be able to read a refusal and answer
           * as though the action happened.
           */
          throw new ToolExecutionError(
            id,
            outcome.error?.message ?? outcome.audit.resultSummary ?? 'The account refused that.',
            { details: { code: outcome.error?.code ?? 'ACCOUNT_REFUSED' } },
          );
        }
        return {
          status: outcome.status,
          ok: outcome.result?.ok ?? false,
          summary:
            outcome.result?.summary ??
            outcome.audit.resultSummary ??
            'The account completed that action.',
          detail: outcome.result?.data === undefined ? '' : JSON.stringify(outcome.result.data),
        };
      },
    });

    if (unavailable) disabled.push({ id, reason });
  }

  return { definitions, implementations, disabled };
}

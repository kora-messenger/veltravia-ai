/**
 * The account tool registry (Step 62).
 *
 * Registration is the only way a capability exists. There is no dynamic
 * discovery, no "run this SQL" escape hatch and no tool whose name implies
 * platform ownership, because the registry refuses those names outright. That is
 * what makes the catalogue something a security review can read end to end.
 */

import {
  ACCOUNT_AGENT_LIMITS,
  AccountAgentError,
  type AccountPermission,
  type AccountTool,
  type AccountToolDefinition,
  type RiskLevel,
} from './types.js';

const NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

/** Namespaces reserved for the platform's own operators, never for this agent. */
const FORBIDDEN_PREFIXES = ['platform.', 'operator.', 'system.', 'root.'];

const PERMISSIONS: readonly AccountPermission[] = [
  'account:read',
  'account:write',
  'workspace:admin',
  'workspace:owner',
];

const RISKS: readonly RiskLevel[] = [1, 2, 3, 4];

export function assertDefinition(definition: AccountToolDefinition): void {
  if (!NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `account tool "${definition.name}" must be named like "group.action" in lower case.`,
    );
  }
  if (FORBIDDEN_PREFIXES.some((prefix) => definition.name.startsWith(prefix))) {
    throw new Error(`account tool "${definition.name}" claims a platform namespace.`);
  }
  if (!RISKS.includes(definition.risk)) {
    throw new Error(`account tool "${definition.name}" has an unknown risk level.`);
  }
  if (!PERMISSIONS.includes(definition.permission)) {
    throw new Error(`account tool "${definition.name}" has an unknown permission.`);
  }
  if (definition.availability.available === false) {
    if (
      definition.availability.reason === undefined ||
      definition.availability.reason.trim().length === 0
    ) {
      throw new Error(
        `account tool "${definition.name}" is unavailable but does not say why; an unexplained gap reads as a bug.`,
      );
    }
  }
  if (definition.risk === 1 && definition.mutates) {
    throw new Error(`account tool "${definition.name}" is risk 1 but claims to change something.`);
  }
  if (definition.risk >= 2 && !definition.mutates) {
    throw new Error(
      `account tool "${definition.name}" is risk ${definition.risk} but changes nothing.`,
    );
  }
  const seen = new Set<string>();
  for (const param of definition.params) {
    if (seen.has(param.name)) {
      throw new Error(`account tool "${definition.name}" declares "${param.name}" twice.`);
    }
    seen.add(param.name);
    if (param.type === 'enum' && (param.values === undefined || param.values.length === 0)) {
      throw new Error(`account tool "${definition.name}" has an enum without values.`);
    }
  }
}

export class AccountToolRegistry {
  private readonly tools = new Map<string, AccountTool>();

  register(tool: AccountTool): void {
    assertDefinition(tool.definition);
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`account tool "${tool.definition.name}" is already registered.`);
    }
    if (this.tools.size >= ACCOUNT_AGENT_LIMITS.maxTools) {
      throw new Error(
        `the account tool registry is full (${ACCOUNT_AGENT_LIMITS.maxTools}); remove a tool before adding another.`,
      );
    }
    this.tools.set(tool.definition.name, tool);
  }

  registerAll(tools: readonly AccountTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): AccountTool | undefined {
    return this.tools.get(name);
  }

  require(name: string): AccountTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new AccountAgentError('UNKNOWN_TOOL', `"${name}" is not an account operation.`, 404, {
        tool: name,
        known: [...this.tools.keys()],
      });
    }
    return tool;
  }

  catalog(): readonly AccountToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((a, b) => a.risk - b.risk || a.name.localeCompare(b.name));
  }

  names(): readonly string[] {
    return [...this.tools.keys()].sort();
  }
}

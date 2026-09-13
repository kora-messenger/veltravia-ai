import {
  DuplicateToolError,
  InvalidToolDefinitionError,
  ToolNotFoundError,
} from '../errors/index.js';
import type { ToolDefinition } from '../types/definition.js';
import { validateToolDefinition } from './validate.js';

/**
 * The tool registry: an ordered, in-memory catalog of VALIDATED tool
 * definitions. A registered tool is a declaration only - registration never
 * grants permissions, never attaches behavior, and never enables execution.
 *
 * - registration validates structure and rejects duplicate ids
 * - retrieval is by unique id and throws ToolNotFoundError when missing
 * - listing preserves registration order (deterministic)
 * - unregistration makes the id available again
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Registers a tool definition. Fails with InvalidToolDefinitionError when
   * the definition violates the contract, and DuplicateToolError when the id
   * already exists. Registration is atomic: a rejected tool leaves the
   * registry untouched.
   */
  register(tool: ToolDefinition): void {
    const reasons = validateToolDefinition(tool);
    if (reasons.length > 0) {
      throw new InvalidToolDefinitionError(reasons);
    }
    if (this.tools.has(tool.id)) {
      throw new DuplicateToolError(tool.id);
    }
    this.tools.set(tool.id, tool);
  }

  /** Retrieves a tool definition by id. Throws when unknown. */
  get(id: string): ToolDefinition {
    const tool = this.tools.get(id);
    if (tool === undefined) {
      throw new ToolNotFoundError(id);
    }
    return tool;
  }

  /** Whether a tool with this id is registered. */
  has(id: string): boolean {
    return this.tools.has(id);
  }

  /** All registered tool definitions, in registration order. */
  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Registered tool ids, in registration order. */
  ids(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Removes a tool definition. Throws when unknown. */
  unregister(id: string): void {
    if (!this.tools.has(id)) {
      throw new ToolNotFoundError(id);
    }
    this.tools.delete(id);
  }
}

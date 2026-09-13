/**
 * Provider-neutral tool categories.
 *
 * A category classifies WHAT KIND of operation a tool performs. It is
 * metadata only: it enables filtering and grouping, and it NEVER implies
 * that a tool in that category is executable - availability is a separate,
 * runtime concept (see availability/).
 *
 * Extensibility: new categories are added by widening this union - a
 * deliberate, reviewed change. The core treats the set as closed so every
 * category is documented and typos cannot slip through.
 */
export const TOOL_CATEGORIES = [
  'data',
  'filesystem',
  'source_control',
  'code',
  'communication',
  'deployment',
  'storage',
  'payments',
  'search',
  'ai',
  'system',
  'other',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export function isToolCategory(value: unknown): value is ToolCategory {
  return typeof value === 'string' && (TOOL_CATEGORIES as readonly string[]).includes(value);
}

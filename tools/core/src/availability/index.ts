/**
 * Tool availability - the runtime answer to "may this tool run RIGHT NOW?".
 *
 * A registered tool is only a DEFINITION; it is never automatically
 * executable. Availability is computed by the ToolManager from lifecycle
 * state, connector integration, and permission grants - never from the
 * definition alone.
 */

export const TOOL_AVAILABILITY_STATES = [
  'available',
  'disabled',
  'unavailable',
  'misconfigured',
  'permission_denied',
  'awaiting_configuration',
] as const;

export type ToolAvailabilityState = (typeof TOOL_AVAILABILITY_STATES)[number];

export function isToolAvailabilityState(value: unknown): value is ToolAvailabilityState {
  return (
    typeof value === 'string' && (TOOL_AVAILABILITY_STATES as readonly string[]).includes(value)
  );
}

/** Point-in-time availability of one tool. */
export interface ToolAvailability {
  readonly state: ToolAvailabilityState;
  /** Human-readable, secret-free explanation. */
  readonly detail?: string;
}

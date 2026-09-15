/**
 * Workspace conversation models.
 *
 * These types define the SAFE view models the workspace renders. Step 11C-2
 * will map live agent/AI API responses into them; until then the workspace
 * renders only real user input and never fabricates AI output.
 *
 * Trust language: every message carries an explicit ORIGIN. The workspace
 * distinguishes user content, assistant (AI) content, system status, and
 * tool output visually — tool output and project data are always rendered
 * as DATA (plain text), never as instructions.
 */

/** Who or what produced a message. Drives the trust presentation. */
export type MessageOrigin = 'user' | 'assistant' | 'system' | 'tool';

/** Safe UI model for one conversation message. */
export interface WorkspaceMessageView {
  readonly id: string;
  readonly origin: MessageOrigin;
  /**
   * Plain text. The workspace renders this with normal React text nodes —
   * no HTML interpretation of message content, ever.
   */
  readonly text: string;
  /** ISO timestamp of when the message was produced, if known. */
  readonly timestamp: string | null;
  /**
   * Optional source caption (e.g. "Tool: github.read" or "Project file:
   * src/App.tsx"). Rendered as data provenance, never as instructions.
   */
  readonly source?: string;
}

/** Safe UI model for one activity entry in the right-hand panel. */
export interface ActivityEntryView {
  readonly id: string;
  /** Short activity label, e.g. "Planning" or "Reading project files". */
  readonly label: string;
  /** Future statuses an agent/tool step can report. */
  readonly status:
    'queued' | 'running' | 'awaiting-confirmation' | 'completed' | 'failed' | 'cancelled';
  /** Longer explanation shown under the label, if any. */
  readonly detail?: string;
  /** Tool activity only: the risk level the Tool System reports. */
  readonly riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /** Tool activity only: whether a human confirmation is/was required. */
  readonly confirmationRequired?: boolean;
}

/** Origin labels used for the accessible/computer-readable trust chips. */
export const ORIGIN_LABELS: Record<MessageOrigin, string> = {
  user: 'You',
  assistant: 'Veltravia AI',
  system: 'System',
  tool: 'Tool output',
};

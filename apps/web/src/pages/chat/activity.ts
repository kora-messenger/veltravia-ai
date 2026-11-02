import type { ReasoningRunView } from '../../api/reasoning';

/**
 * What the chat says while a run is working.
 *
 * Every word here comes from the run the server reported: the step's own intent,
 * or the plan's next intent, or a plain "Working on it" when the run has
 * published nothing yet. Nothing is invented to make the line look busier than
 * the run actually is, and nothing from the model's hidden reasoning is shown.
 */

export interface ActivityStep {
  readonly id: string;
  readonly label: string;
  readonly status: 'success' | 'failed' | 'rejected' | 'pending_confirmation';
  readonly durationMs: number | null;
}

export interface ChatActivity {
  /** The current thing being done, taken from the run. */
  readonly label: string;
  readonly steps: readonly ActivityStep[];
  /** True while the server still reports the run as running. */
  readonly running: boolean;
}

/** Enough history to explain a run without turning the line into a log. */
export const MAX_ACTIVITY_STEPS = 12;
/** Longer labels are trimmed, not wrapped onto three lines. */
const MAX_LABEL_CHARS = 80;

const titleCase = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

export function shorten(text: string, max = MAX_LABEL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Derives the line from the run.
 *
 * - the last executed step's intent, which is the only thing actually happening
 * - otherwise the plan's first intent, marked as next so it is not mistaken for
 *   work already done
 * - otherwise a plain "Working on it", because a run with no published steps has
 *   told us nothing more specific
 */
export function describeActivity(run: ReasoningRunView): ChatActivity {
  const steps = run.steps.slice(-MAX_ACTIVITY_STEPS).map((step) => ({
    id: step.id,
    label: shorten(titleCase(step.intent)),
    status: step.status,
    durationMs: step.durationMs ?? null,
  }));

  const last = steps[steps.length - 1];
  let label: string;
  if (last !== undefined) {
    label = last.label;
  } else {
    const planned = run.plan?.steps[0]?.intent;
    label =
      planned === undefined || planned.trim() === ''
        ? 'Working on it'
        : `Next: ${shorten(titleCase(planned))}`;
  }

  return { label, steps, running: run.status === 'running' };
}

/** Formats a step duration the way a person reads it. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // Round in integers first: 1450/1000 = 1.45, which float formatting reports
  // as "1.4" because 1.45 has no exact binary form.
  if (ms < 10000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

export const STEP_LABEL: Record<ActivityStep['status'], string> = {
  success: 'Done',
  failed: 'Failed',
  rejected: 'Refused',
  pending_confirmation: 'Waiting for approval',
};

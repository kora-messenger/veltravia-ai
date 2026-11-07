/**
 * Resource governance for one worker.
 *
 * Every ceiling is enforced here, in the server, against what was recorded in
 * the assignment. A model cannot raise its own budget: it can only ask for a
 * tool, and a tool call costs one from the budget this file owns.
 */

import { WorkerError } from '@veltravia/worker-core';

export interface BudgetLimits {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly maxOutputBytes: number;
}

export const BUDGET_CEILINGS: BudgetLimits = {
  maxModelCalls: 12,
  maxToolCalls: 60,
  maxTokens: 60_000,
  maxOutputBytes: 400_000,
};

export const BUDGET_DEFAULTS: BudgetLimits = {
  maxModelCalls: 6,
  maxToolCalls: 40,
  maxTokens: 24_000,
  maxOutputBytes: 160_000,
};

export interface BudgetState {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly outputBytes: number;
}

/**
 * Clamps a requested budget to the defaults and the hard ceiling. A larger
 * request is reduced and reported, never silently granted.
 */
export function resolveLimits(requested: Partial<BudgetLimits> = {}): {
  readonly limits: BudgetLimits;
  readonly reduced: readonly string[];
} {
  const reduced: string[] = [];
  const pick = (key: keyof BudgetLimits): number => {
    const wanted = requested[key];
    const base = BUDGET_DEFAULTS[key];
    if (wanted === undefined || !Number.isFinite(wanted) || wanted <= 0) return base;
    const capped = Math.min(Math.floor(wanted), BUDGET_CEILINGS[key]);
    if (wanted > BUDGET_CEILINGS[key]) reduced.push(key);
    return Math.max(1, capped);
  };
  return {
    limits: {
      maxModelCalls: pick('maxModelCalls'),
      maxToolCalls: pick('maxToolCalls'),
      maxTokens: pick('maxTokens'),
      maxOutputBytes: pick('maxOutputBytes'),
    },
    reduced,
  };
}

export class WorkerBudget {
  private readonly limits: BudgetLimits;
  private modelCalls = 0;
  private toolCalls = 0;
  private tokens = 0;
  private outputBytes = 0;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  get state(): BudgetState {
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      outputBytes: this.outputBytes,
    };
  }

  /** True when one more model call is allowed. */
  get canCallModel(): boolean {
    return this.modelCalls < this.limits.maxModelCalls && this.tokens < this.limits.maxTokens;
  }

  chargeModel(inputTokens: number, outputTokens: number): void {
    this.modelCalls += 1;
    this.tokens += Math.max(0, inputTokens) + Math.max(0, outputTokens);
  }

  chargeTool(bytes: number): void {
    this.toolCalls += 1;
    this.outputBytes += Math.max(0, bytes);
    if (this.toolCalls > this.limits.maxToolCalls) {
      throw new WorkerError(
        'WORKER_TOOL_BUDGET_EXCEEDED',
        'That worker used every tool call it was allowed.',
      );
    }
    if (this.outputBytes > this.limits.maxOutputBytes) {
      throw new WorkerError(
        'WORKER_OUTPUT_TOO_LARGE',
        'The tool output for that worker grew past the size it was allowed.',
      );
    }
  }

  /** Refuses rather than looping when the model budget is spent. */
  assertCanContinue(): void {
    if (this.modelCalls >= this.limits.maxModelCalls) {
      throw new WorkerError(
        'WORKER_MODEL_BUDGET_EXCEEDED',
        'That worker used every model call it was allowed.',
      );
    }
    if (this.tokens >= this.limits.maxTokens) {
      throw new WorkerError('WORKER_TOKEN_BUDGET_EXCEEDED', 'That worker used its token budget.');
    }
  }
}

/**
 * The Central Primary Agent contract.
 *
 * Veltravia has exactly one user-facing assistant per owner. It is the only
 * thing that talks to the user, and it stays accountable for the outcome even
 * when a worker does the work. This file is the written form of that: what the
 * primary agent owns, what it may never hand away, and the rule it uses to
 * decide whether delegating is worth it at all.
 *
 * `PRIMARY_AGENT_REGISTRY` is the enforcement, such as it is: registering a
 * second primary for the same owner is refused. Workers register as workers.
 */

import { OrchestrationError } from './errors.js';

export type ResponsibilityId =
  | 'user_interaction'
  | 'request_understanding'
  | 'task_planning'
  | 'task_decomposition'
  | 'delegation_decision'
  | 'assignment_creation'
  | 'dependency_coordination'
  | 'progress_monitoring'
  | 'result_review'
  | 'work_integration'
  | 'final_verification_response';

export interface Responsibility {
  readonly id: ResponsibilityId;
  readonly statement: string;
  /** True when no worker may ever perform this, whatever the task size. */
  readonly neverDelegated: boolean;
}

export const PRIMARY_AGENT_RESPONSIBILITIES: readonly Responsibility[] = [
  {
    id: 'user_interaction',
    statement: 'Receive the request, ask clarifying questions and answer the user.',
    neverDelegated: true,
  },
  {
    id: 'request_understanding',
    statement: 'Decide what the user actually wants, including what they left unsaid.',
    neverDelegated: true,
  },
  {
    id: 'task_planning',
    statement: 'Turn the request into a plan with an order and a stopping condition.',
    neverDelegated: true,
  },
  {
    id: 'task_decomposition',
    statement: 'Split the plan into units of work small enough to be judged.',
    neverDelegated: false,
  },
  {
    id: 'delegation_decision',
    statement: 'Decide whether delegating is worth it, and how many workers are justified.',
    neverDelegated: true,
  },
  {
    id: 'assignment_creation',
    statement: 'Write the assignment: objective, scope, outputs, acceptance and limits.',
    neverDelegated: false,
  },
  {
    id: 'dependency_coordination',
    statement: 'Decide what must happen before what, and hold a task until its inputs exist.',
    neverDelegated: true,
  },
  {
    id: 'progress_monitoring',
    statement: 'Watch progress, notice a stalled or blocked task, and intervene.',
    neverDelegated: true,
  },
  {
    id: 'result_review',
    statement: 'Judge returned work against the acceptance criteria. A worker cannot mark it done.',
    neverDelegated: true,
  },
  {
    id: 'work_integration',
    statement: 'Integrate accepted work into the project, resolving conflicts itself.',
    neverDelegated: true,
  },
  {
    id: 'final_verification_response',
    statement: 'Verify the integrated result and report it to the user in their own terms.',
    neverDelegated: true,
  },
];

export interface PrimaryAgentContract {
  readonly version: number;
  readonly name: string;
  readonly summary: string;
  readonly responsibilities: readonly Responsibility[];
  readonly invariants: readonly string[];
  readonly delegationRule: string;
  /**
   * What is NOT true yet, said plainly. A contract that oversells itself is
   * worse than a smaller one that holds.
   */
  readonly notYetImplemented: readonly string[];
}

export const CENTRAL_PRIMARY_AGENT_CONTRACT: PrimaryAgentContract = {
  version: 1,
  name: 'Central Primary Agent',
  summary:
    'One assistant per owner. It understands, plans, decides on delegation, monitors, reviews and answers. Workers execute a bounded piece and return it; they never speak to the user and never close a task.',
  responsibilities: PRIMARY_AGENT_RESPONSIBILITIES,
  invariants: [
    'One primary agent per owner. A second registration is refused.',
    'Every task has an authenticated owner and a project scope the server verified.',
    'A worker result is a proposal: only a recorded review completes a task.',
    'Every status change writes an event in the same transaction as the change.',
    'No provider credential, secret or hidden reasoning is stored on a task, an assignment, an attempt or an event.',
    'A chat id is a label, not a credential: access is always decided by owner and project.',
  ],
  delegationRule:
    'Delegate only when the work is separable, large enough that the primary agent would otherwise serialise it, and judgeable by acceptance criteria. Keep work inline when it is small, when it needs the user, when it needs the conversation, or when correctness depends on context that only the primary agent holds.',
  notYetImplemented: [
    'No worker executes an assignment yet. Assignments are contracts; nothing in this step spawns or schedules a worker.',
    'No automatic worker recovery, retry backoff or progress watchdog runs.',
    'No conflict-safe merging of two workers editing the same workspace exists.',
    'Parallel execution is not scheduled. Step 43 is where bounded execution belongs.',
  ],
};

export interface DelegationSignal {
  readonly estimatedSteps: number;
  readonly independentParts: number;
  readonly parallelizable: boolean;
  readonly requiresLongRunningWork: boolean;
  readonly requiresUserInput: boolean;
  readonly requiresConversationContext: boolean;
}

export interface DelegationAssessment {
  readonly delegate: boolean;
  /** 0-100. A documented heuristic, not a model judgement. */
  readonly score: number;
  readonly recommendedWorkers: number;
  readonly reasons: readonly string[];
}

const STEP_THRESHOLD = 8;
const PART_THRESHOLD = 2;

/**
 * A transparent first rule for the delegation decision.
 *
 * Deterministic on purpose: the primary agent can compute it, a test can pin
 * it, and the user can be told why. It is a floor, not the whole judgement -
 * the primary agent may still keep work inline.
 */
export function assessDelegation(signal: DelegationSignal): DelegationAssessment {
  const reasons: string[] = [];
  let score = 0;

  if (signal.requiresUserInput) {
    reasons.push('The work needs an answer from the user, so it stays in the conversation.');
    return { delegate: false, score: 0, recommendedWorkers: 0, reasons };
  }
  if (signal.requiresConversationContext) {
    reasons.push('The work depends on context only the primary agent holds.');
    return { delegate: false, score: 0, recommendedWorkers: 0, reasons };
  }

  if (signal.estimatedSteps >= STEP_THRESHOLD) {
    score += 40;
    reasons.push(`${signal.estimatedSteps} steps is large enough to be worth handing over.`);
  } else {
    score += Math.min(30, signal.estimatedSteps * 3);
  }

  if (signal.independentParts >= PART_THRESHOLD) {
    score += 30;
    reasons.push(
      `${signal.independentParts} independent parts could run without waiting on each other.`,
    );
  } else {
    reasons.push('The work is not separable into independent parts.');
  }

  if (signal.parallelizable) {
    score += 20;
    reasons.push('The parts do not touch the same files, so parallel work is safe to plan for.');
  }

  if (signal.requiresLongRunningWork) {
    score += 10;
    reasons.push(
      'The work is long-running, so blocking the conversation would be the wrong trade.',
    );
  }

  const capped = Math.max(0, Math.min(100, score));
  const delegate = capped >= 50 && signal.independentParts >= PART_THRESHOLD;
  return {
    delegate,
    score: capped,
    recommendedWorkers: delegate ? Math.min(4, Math.max(1, signal.independentParts)) : 0,
    reasons,
  };
}

/**
 * Who is registered for one owner. A registry entry is a declaration of role,
 * not a running process: registering a worker does not start anything.
 */
export type AgentRole = 'primary' | 'worker';

export interface AgentRegistration {
  readonly ownerRef: string;
  readonly agentId: string;
  readonly role: AgentRole;
  readonly label: string;
}

export class PrimaryAgentRegistry {
  private readonly byOwner = new Map<string, Map<string, AgentRegistration>>();

  register(entry: AgentRegistration): void {
    const existing = this.byOwner.get(entry.ownerRef) ?? new Map<string, AgentRegistration>();
    if (entry.role === 'primary') {
      for (const [agentId, registration] of existing) {
        if (registration.role === 'primary' && agentId !== entry.agentId) {
          throw new OrchestrationError(
            'PRIMARY_AGENT_CONFLICT',
            'This owner already has a primary agent. A second user-facing assistant is not allowed.',
          );
        }
      }
    }
    existing.set(entry.agentId, entry);
    this.byOwner.set(entry.ownerRef, existing);
  }

  primaryFor(ownerRef: string): AgentRegistration | null {
    for (const registration of this.byOwner.get(ownerRef)?.values() ?? []) {
      if (registration.role === 'primary') return registration;
    }
    return null;
  }

  workersFor(ownerRef: string): readonly AgentRegistration[] {
    return [...(this.byOwner.get(ownerRef)?.values() ?? [])].filter(
      (registration) => registration.role === 'worker',
    );
  }

  /** Responsibilities that may never be delegated, whichever agent asks. */
  reservedResponsibilities(): readonly ResponsibilityId[] {
    return PRIMARY_AGENT_RESPONSIBILITIES.filter((entry) => entry.neverDelegated).map(
      (entry) => entry.id,
    );
  }
}

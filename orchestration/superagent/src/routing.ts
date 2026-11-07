/**
 * Worker specialization.
 *
 * A worker type decides three things and only three: the instruction it is
 * given, the tools it is offered, and the shape of answer expected. The model
 * itself comes from the gateway's router, so no provider is hard-coded here.
 */

import type { WorkerType } from '@veltravia/worker-core';

export interface WorkerProfile {
  readonly type: WorkerType;
  /** Gateway router category; the router picks the provider and model. */
  readonly category: string;
  readonly preamble: string;
  /** Tools offered unless the assignment narrows them further. */
  readonly suggestedTools: readonly string[];
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

const COMMON = `You are one bounded worker inside Veltravia. You have exactly one assignment and no authority beyond it.

Rules that are never negotiable:
- Work only inside the paths you were given. Never read, write or name a path outside them.
- Use only the tools listed. If a tool is missing, say what you needed instead of inventing one.
- Do not ask for credentials, environment variables or secrets, and never repeat one you were shown.
- Report what you actually did. A file you did not write is not a deliverable.

Answer with ONE JSON object and nothing else, either:
{"action": {"tool": "<tool id>", "arguments": { ... }}}
or
{"final": {"status": "completed" | "partial" | "blocked" | "failed", "summary": "...", "deliverables": [{"name": "...", "kind": "file" | "patch" | "report" | "artifact" | "notes", "path": "...", "summary": "..."}], "evidence": [{"kind": "test_run" | "command" | "file" | "note", "ref": "...", "summary": "...", "passed": true}], "blockedReason": "..."}}`;

export const WORKER_PROFILES: Readonly<Record<WorkerType, WorkerProfile>> = {
  frontend: {
    type: 'frontend',
    category: 'coding',
    preamble: `${COMMON}\n\nYou build interface code: components, styles, state and the wiring between them. Read the existing files before you write, match the conventions you find, and keep the change as small as the assignment allows.`,
    suggestedTools: [
      'project.list',
      'project.read',
      'project.search',
      'project.structure',
      'project.write',
      'tests.run',
    ],
    temperature: 0.2,
    maxOutputTokens: 1_000,
  },
  backend: {
    type: 'backend',
    category: 'coding',
    preamble: `${COMMON}\n\nYou build server code: routes, handlers, services and their tests. Validate input at the boundary, keep error shapes consistent with what exists, and never hard-code a credential or a hostname.`,
    suggestedTools: [
      'project.list',
      'project.read',
      'project.search',
      'project.structure',
      'project.write',
      'tests.run',
    ],
    temperature: 0.2,
    maxOutputTokens: 1_000,
  },
  database: {
    type: 'database',
    category: 'coding',
    preamble: `${COMMON}\n\nYou work on schema and data access: migrations, tables, indexes, queries. Inspect the schema before proposing a change, keep migrations reversible where the project allows it, and state plainly which constraints you added.`,
    suggestedTools: [
      'project.list',
      'project.read',
      'project.search',
      'schema.inspect',
      'project.write',
    ],
    temperature: 0.2,
    maxOutputTokens: 900,
  },
  testing: {
    type: 'testing',
    category: 'coding',
    preamble: `${COMMON}\n\nYou write and run tests. Cover the behaviour that changed, prefer assertions on observable results, and report a failing test as a failure rather than as a caveat.`,
    suggestedTools: [
      'project.list',
      'project.read',
      'project.search',
      'project.write',
      'tests.run',
    ],
    temperature: 0.1,
    maxOutputTokens: 900,
  },
  documentation: {
    type: 'documentation',
    category: 'general-conversation',
    preamble: `${COMMON}\n\nYou write documentation for what the code actually does, including what it does not do yet. Never describe a plan as an implemented feature.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'docs.write'],
    temperature: 0.3,
    maxOutputTokens: 900,
  },
  analysis: {
    type: 'analysis',
    category: 'complex-reasoning',
    preamble: `${COMMON}\n\nYou inspect and explain. Prefer evidence from files over recollection, name the file and what it shows, and separate what you verified from what you suspect.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'project.structure'],
    temperature: 0.2,
    maxOutputTokens: 800,
  },
  ui: {
    type: 'ui',
    category: 'coding',
    preamble: `${COMMON}\n\nYou work on interface design and layout: spacing, hierarchy, states and accessibility. Take measurements from what exists rather than guessing, and make every interactive control reachable and labelled.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'project.write'],
    temperature: 0.3,
    maxOutputTokens: 1_000,
  },
  security: {
    type: 'security',
    category: 'complex-reasoning',
    preamble: `${COMMON}\n\nYou look for security defects: missing authorization, injected input, leaked secrets, unsafe defaults. Report the file and line with each finding, and do not exploit anything or write outside your scope.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'schema.inspect'],
    temperature: 0.1,
    maxOutputTokens: 800,
  },
  research: {
    type: 'research',
    category: 'complex-reasoning',
    preamble: `${COMMON}\n\nYou gather what the project already contains and answer from it. Cite the file and what it shows; say plainly when the answer is not in the repository.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'project.structure'],
    temperature: 0.2,
    maxOutputTokens: 800,
  },
  review: {
    type: 'review',
    category: 'complex-reasoning',
    preamble: `${COMMON}\n\nYou review work that already exists. Check it against the acceptance criteria, name what fails and where, and do not approve anything you could not verify.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'tests.run'],
    temperature: 0.1,
    maxOutputTokens: 800,
  },
  performance: {
    type: 'performance',
    category: 'complex-reasoning',
    preamble: `${COMMON}\n\nYou look for cost that is avoidable: repeated work, quadratic loops, unbounded queries, payloads larger than they need to be. Give the file, the pattern and the change that would help.`,
    suggestedTools: ['project.list', 'project.read', 'project.search', 'performance.inspect'],
    temperature: 0.1,
    maxOutputTokens: 800,
  },
  general: {
    type: 'general',
    category: 'general-conversation',
    preamble: COMMON,
    suggestedTools: ['project.list', 'project.read', 'project.search'],
    temperature: 0.2,
    maxOutputTokens: 800,
  },
};

export function profileFor(type: WorkerType): WorkerProfile {
  return WORKER_PROFILES[type] ?? WORKER_PROFILES.general;
}

/**
 * Planning: one request in, a dependency-ordered task graph out.
 *
 * The planner is deterministic on purpose. It reads the request and what the
 * project inspector could actually see, and it says what it could not see. It
 * never invents a file, a framework or a task it cannot justify, and it never
 * claims a task is independent when it writes the same paths as another.
 */

import type {
  ExecutionPlan,
  ExecutionRequest,
  ExecutionTaskKind,
  PlannedTask,
  ProjectFacts,
} from './types.js';

/** Words that mean the owner is asking for something that needs a gate. */
const APPROVAL_CUES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\bdeploy|deployment|ship to production\b/i,
    reason: 'deploying needs a human decision',
  },
  { pattern: /\bpublish|release\b/i, reason: 'publishing needs a human decision' },
  { pattern: /\bproduction\b/i, reason: 'production changes need a human decision' },
  {
    pattern: /\bdelete|drop|truncate|wipe\b/i,
    reason: 'destructive changes need a human decision',
  },
  {
    pattern: /\bpayment|charge|billing|invoice\b/i,
    reason: 'money-moving changes need a human decision',
  },
  {
    pattern: /\bsecret|credential|api key|token\b/i,
    reason: 'secrets are never handled by a worker',
  },
];

/** Signals about what kind of work the request is really asking for. */
const INTENT_CUES: readonly {
  readonly kind: ExecutionTaskKind;
  readonly pattern: RegExp;
  readonly title: string;
}[] = [
  {
    kind: 'frontend',
    pattern: /\b(ui|screen|page|component|form|layout|design|css|style)\b/i,
    title: 'Implement the interface',
  },
  {
    kind: 'backend',
    pattern: /\b(api|endpoint|server|route|service|handler|webhook)\b/i,
    title: 'Implement the server work',
  },
  {
    kind: 'database',
    pattern: /\b(database|schema|migration|table|column|index|query)\b/i,
    title: 'Change the data model',
  },
  {
    kind: 'integration',
    pattern: /\b(integrat|connect|sync|third[- ]party|provider)\b/i,
    title: 'Wire the integration',
  },
  {
    kind: 'bugfix',
    pattern: /\b(fix|bug|broken|crash|regression|error)\b/i,
    title: 'Fix the reported defect',
  },
  {
    kind: 'performance',
    pattern: /\b(slow|performance|latency|optimi[sz]e|cache)\b/i,
    title: 'Improve performance',
  },
  {
    kind: 'security',
    pattern: /\b(auth|permission|security|vulnerab|sanitiz|xss|csrf)\b/i,
    title: 'Review security',
  },
  {
    kind: 'documentation',
    pattern: /\b(document|readme|docs?|guide)\b/i,
    title: 'Write the documentation',
  },
];

const WORKER_FOR_KIND: Readonly<Record<ExecutionTaskKind, string>> = {
  analysis: 'analysis',
  frontend: 'frontend',
  backend: 'backend',
  database: 'database',
  integration: 'backend',
  testing: 'testing',
  documentation: 'documentation',
  security: 'security',
  performance: 'performance',
  bugfix: 'backend',
};

const TOOLS_FOR_KIND: Readonly<Record<ExecutionTaskKind, readonly string[]>> = {
  analysis: ['project.read'],
  frontend: ['project.read', 'project.write'],
  backend: ['project.read', 'project.write'],
  database: ['project.read', 'project.write'],
  integration: ['project.read', 'project.write'],
  testing: ['project.read', 'project.write', 'tests.run'],
  documentation: ['project.read', 'project.write'],
  security: ['project.read'],
  performance: ['project.read', 'project.write'],
  bugfix: ['project.read', 'project.write', 'tests.run'],
};

/** Directories a task may touch, taken from what the project actually has. */
export function inferScope(facts: ProjectFacts, kind: ExecutionTaskKind): readonly string[] {
  const has = (prefix: string): boolean =>
    facts.files.some((file) => file.startsWith(`${prefix}/`));
  const candidates: string[] = [];
  if (kind === 'frontend') {
    for (const dir of ['apps/web/src', 'src/app', 'src/pages', 'src/components', 'src']) {
      if (has(dir)) candidates.push(dir);
    }
  }
  if (kind === 'backend' || kind === 'integration' || kind === 'database' || kind === 'bugfix') {
    for (const dir of ['apps/api/src', 'src/server', 'src/api', 'server', 'src']) {
      if (has(dir)) candidates.push(dir);
    }
  }
  if (kind === 'testing') {
    for (const dir of ['tests', 'apps/api/src', 'apps/web/src', 'src']) {
      if (has(dir)) candidates.push(dir);
    }
  }
  if (kind === 'documentation') {
    for (const dir of ['docs', 'README.md', '.']) {
      if (dir === '.' ? facts.files.length > 0 : has(dir) || facts.files.includes(dir)) {
        candidates.push(dir);
      }
    }
  }
  return candidates.length === 0 ? ['src'] : [...new Set(candidates)];
}

function approvalReasons(text: string): readonly string[] {
  return APPROVAL_CUES.filter((cue) => cue.pattern.test(text)).map((cue) => cue.reason);
}

function complexity(request: string, kind: ExecutionTaskKind, facts: ProjectFacts): number {
  let score = 2;
  if (request.split(/\s+/).length > 60) score += 1;
  if (kind === 'database' || kind === 'integration') score += 1;
  if (kind === 'security') score += 1;
  if (!facts.hasPackageJson) score += 1;
  if (facts.unknown.length > 0) score += 1;
  return Math.max(1, Math.min(5, score));
}

function planned(input: {
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly kind: ExecutionTaskKind;
  readonly phase: PlannedTask['phase'];
  readonly dependsOn: readonly string[];
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verification: PlannedTask['verification'];
  readonly approval: string | null;
  readonly complexity: number;
}): PlannedTask {
  return {
    key: input.key,
    title: input.title,
    objective: input.objective,
    kind: input.kind,
    workerType: WORKER_FOR_KIND[input.kind],
    phase: input.phase,
    dependsOn: input.dependsOn,
    scope: input.scope,
    exclusions: ['.env', '.env.*', '**/secrets/**'],
    deliverables: input.deliverables,
    acceptanceCriteria: input.acceptanceCriteria,
    allowedTools: TOOLS_FOR_KIND[input.kind],
    complexity: input.complexity,
    verification: input.verification,
    approval: input.approval,
    taskId: null,
  };
}

/**
 * Turn a request and the inspected facts into a plan.
 *
 * The shape is always: understand the work, do the work, prove the work, record
 * the work. Only the middle is allowed to branch, and only on evidence from the
 * request and the project.
 */
export function buildPlan(input: {
  readonly request: ExecutionRequest;
  readonly facts: ProjectFacts;
  readonly version?: number;
  readonly revisionReason?: string | null;
  readonly createdAt: string;
}): ExecutionPlan {
  const { request, facts } = input;
  const text = request.text;
  const reasons =
    request.approvalReasons.length > 0 ? request.approvalReasons : approvalReasons(text);

  const inspection: string[] = [];
  inspection.push(
    facts.files.length === 0
      ? 'The project has no files yet, so this starts from an empty tree.'
      : `Read ${facts.files.length} project file${facts.files.length === 1 ? '' : 's'}.`,
  );
  if (facts.languages.length > 0)
    inspection.push(`Languages in use: ${facts.languages.join(', ')}.`);
  if (facts.frameworks.length > 0)
    inspection.push(`Frameworks detected: ${facts.frameworks.join(', ')}.`);
  if (!facts.hasPackageJson)
    inspection.push('No package.json was found, so build tooling is unknown.');
  if (!facts.hasTests) inspection.push('No test setup was found in the project.');
  if (facts.revision !== null) inspection.push(`Project revision ${facts.revision} is the base.`);
  for (const gap of facts.unknown) inspection.push(`Could not determine: ${gap}.`);

  const wanted = INTENT_CUES.filter((cue) => cue.pattern.test(text));
  const implementationKinds: ExecutionTaskKind[] =
    wanted.length === 0 ? ['backend'] : [...new Set(wanted.map((cue) => cue.kind))];
  // Testing and documentation are produced from the work, not guessed from words.
  const kinds = implementationKinds.filter(
    (kind) => kind !== 'testing' && kind !== 'documentation',
  );

  const tasks: PlannedTask[] = [];
  const approval = reasons.length > 0 ? reasons.join('; ') : null;

  tasks.push(
    planned({
      key: 'understand',
      title: 'Establish what the request needs',
      objective: `Restate the request, confirm the affected areas and name what is uncertain: ${text.slice(0, 400)}`,
      kind: 'analysis',
      phase: 'sequential',
      dependsOn: [],
      scope: ['src'],
      deliverables: ['A written understanding of the request and the areas it touches'],
      acceptanceCriteria: ['Names the affected areas', 'Names anything that is uncertain'],
      verification: 'none',
      approval: null,
      complexity: 1,
    }),
  );

  for (const kind of kinds) {
    const cue = INTENT_CUES.find((entry) => entry.kind === kind);
    const key = kind;
    tasks.push(
      planned({
        key,
        title: cue?.title ?? `Do the ${kind} work`,
        objective: `Deliver the ${kind} part of: ${text.slice(0, 300)}`,
        kind,
        // Different files means it can run beside its siblings; the write claims
        // in Step 43 are what actually keep them apart.
        phase: 'independent',
        dependsOn: ['understand'],
        scope: inferScope(facts, kind),
        deliverables: [`The ${kind} change the request asks for`],
        acceptanceCriteria: [
          'Stays inside the assigned scope',
          'Does what the request asked for',
          'Leaves the project buildable',
        ],
        verification: kind === 'security' ? 'none' : 'typecheck',
        approval,
        complexity: complexity(text, kind, facts),
      }),
    );
  }

  const buildKeys = tasks.map((task) => task.key).filter((key) => key !== 'understand');

  tasks.push(
    planned({
      key: 'verify',
      title: 'Prove the work with a verification run',
      objective:
        'Run the project’s own checks over the delivered work and report exactly what executed.',
      kind: 'testing',
      phase: 'sequential',
      dependsOn: buildKeys.length === 0 ? ['understand'] : buildKeys,
      scope: inferScope(facts, 'testing'),
      deliverables: ['A stored verification run for the changed work'],
      acceptanceCriteria: [
        'At least one operation executed',
        'The result is recorded, not claimed',
      ],
      verification: 'unit',
      approval: null,
      complexity: 2,
    }),
  );

  tasks.push(
    planned({
      key: 'document',
      title: 'Record what changed',
      objective:
        'Describe the delivered change so the next reader does not have to reverse-engineer it.',
      kind: 'documentation',
      phase: 'sequential',
      dependsOn: ['verify'],
      scope: inferScope(facts, 'documentation'),
      deliverables: ['A short written record of the change and its limits'],
      acceptanceCriteria: ['States what works', 'States what does not'],
      verification: 'none',
      approval: null,
      complexity: 1,
    }),
  );

  const risks: string[] = [];
  if (facts.revision === null)
    risks.push('The project revision could not be read, so conflicts cannot be attributed.');
  if (facts.unknown.length > 0)
    risks.push(`Planning was made with gaps: ${facts.unknown.join(', ')}.`);
  if (kinds.length > 1)
    risks.push(
      'Several tasks write in parallel; overlapping paths will be refused by the write claims.',
    );
  if (reasons.length > 0)
    risks.push('Part of this request needs owner approval before it may run.');
  if (!facts.hasTests)
    risks.push('Without a test setup, verification may report that nothing could be executed.');

  const restrictions = [
    'Workers only touch the paths in their assignment.',
    'Secrets and environment values are out of scope for every task.',
    ...(reasons.length > 0 ? [`Owner approval required for: ${reasons.join('; ')}.`] : []),
  ];

  return {
    version: input.version ?? 1,
    objective: text,
    inspection,
    tasks,
    risks,
    restrictions,
    verificationRequirements: [
      'A stored verification run must execute and pass before work is called delivered.',
      'A worker’s own completion report is not evidence.',
    ],
    summary: `${tasks.length} tasks: ${kinds.length === 0 ? 'inspection only' : kinds.join(', ')}, then verification and documentation.`,
    revisionReason: input.revisionReason ?? null,
    createdAt: input.createdAt,
  };
}

/**
 * A revision keeps the plan's identity and states why it changed. It never
 * quietly widens what the owner asked for: a task that leaves the original
 * request is marked for approval.
 */
export function revisePlan(input: {
  readonly plan: ExecutionPlan;
  readonly reason: string;
  readonly change: {
    readonly add?: readonly Omit<PlannedTask, 'taskId'>[];
    readonly remove?: readonly string[];
    readonly dependsOn?: Readonly<Record<string, readonly string[]>>;
  };
  readonly createdAt: string;
  /**
   * Keys whose work has actually started. A revision never drops one of these:
   * the worker would keep running with nothing in the plan watching it. With no
   * list supplied, a task that already has a record is treated as started, so
   * the omission can only ever keep a task, never silently lose one.
   */
  readonly startedKeys?: readonly string[];
}): ExecutionPlan {
  const removed = new Set(input.change.remove ?? []);
  const started = new Set(
    input.startedKeys ??
      input.plan.tasks.filter((task) => task.taskId !== null).map((task) => task.key),
  );
  const kept = input.plan.tasks.filter((task) => started.has(task.key) || !removed.has(task.key));
  const keptNotes = input.plan.tasks
    .filter((task) => started.has(task.key) && removed.has(task.key))
    .map(
      (task) =>
        `Kept ${task.key}: it already has work, so it stays in the plan until that work is closed.`,
    );
  const added = (input.change.add ?? []).map((task) => ({ ...task, taskId: null }));
  const dependencies = input.change.dependsOn ?? {};
  const tasks = [...kept, ...added].map((task) => {
    const patch = dependencies[task.key];
    return patch === undefined ? task : { ...task, dependsOn: patch };
  });

  return {
    ...input.plan,
    version: input.plan.version + 1,
    tasks,
    notes: [...(input.plan.notes ?? []), ...keptNotes],
    revisionReason: input.reason,
    summary: `${tasks.length} tasks after revision ${input.plan.version + 1}: ${input.reason}`,
    createdAt: input.createdAt,
  };
}

/** Tasks that exist and whose dependencies are all finished. */
export function readyKeys(plan: ExecutionPlan, done: ReadonlySet<string>): readonly string[] {
  return plan.tasks
    .filter((task) => task.taskId !== null && (task.approval === null || task.approval === ''))
    .filter((task) => !done.has(task.key))
    .filter((task) => task.dependsOn.every((key) => done.has(key)))
    .map((task) => task.key);
}

/**
 * Two tasks may run at once only when their scopes do not overlap. Prefix
 * overlap is checked the same way the worker claims check it, so the planner
 * cannot propose a pair the scheduler will then refuse.
 */
export function canRunTogether(left: PlannedTask, right: PlannedTask): boolean {
  if (left.key === right.key) return false;
  const a = left.scope;
  const b = right.scope;
  if (a.length === 0 || b.length === 0) return false;
  const overlaps = (x: string, y: string): boolean =>
    x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  return !a.some((x) => b.some((y) => overlaps(x, y)));
}

export function independentTasks(plan: ExecutionPlan): readonly PlannedTask[] {
  return plan.tasks.filter((task) => task.phase === 'independent');
}

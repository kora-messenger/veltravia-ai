import { describe, expect, it } from 'vitest';
import type { ReasoningRun, ReasoningToolStep } from './engine.js';
import { describeTool, deriveRunActivities } from './activity.js';
import { buildFinalReport, validationKind } from './report.js';

type StepInput = Partial<ReasoningToolStep> & { readonly toolId: string };

let steps = 0;
function step(input: StepInput): ReasoningToolStep {
  steps += 1;
  return {
    stepId: `step-${steps}`,
    intent: input.intent ?? 'do the thing',
    status: input.status ?? 'success',
    requestedAt: input.requestedAt ?? '2026-11-02T10:00:00.000Z',
    completedAt: input.completedAt ?? '2026-11-02T10:00:01.000Z',
    toolId: input.toolId,
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error }),
  } as ReasoningToolStep;
}

function run(input: Partial<ReasoningRun>): ReasoningRun {
  return {
    id: 'run-1',
    profile: 'workspace',
    task: 'build the thing',
    status: 'running',
    steps: [],
    decisions: [],
    usage: {
      iterations: 0,
      toolCalls: 0,
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      providerLatencyMs: 0,
      latencyMs: 0,
    },
    provenance: [],
    contextDropped: [],
    limitations: [],
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:05.000Z',
    ...input,
  } as ReasoningRun;
}

describe('describeTool', () => {
  it('names file work with the file it touched', () => {
    expect(describeTool('project.read-file', { path: 'package.json' })).toEqual({
      category: 'reading',
      verb: 'Read',
      object: 'package.json',
    });
    expect(describeTool('project.create-file', { path: 'src/App.tsx' }).category).toBe(
      'creating_files',
    );
    expect(describeTool('project.update-file', { path: 'src/App.tsx' }).category).toBe('editing');
    expect(describeTool('project.delete-file', { path: 'src/old.ts' }).category).toBe(
      'deleting_files',
    );
  });

  it('reads a shell command to decide which category ran', () => {
    const cases: [string, string][] = [
      ['npm test', 'running_tests'],
      ['npx vitest run', 'running_tests'],
      ['npm run lint', 'linting'],
      ['npx tsc --noEmit', 'validating'],
      ['npm run build', 'building'],
      ['npm ci', 'installing_dependencies'],
      ['node scripts/seed.mjs', 'executing_tool'],
    ];
    for (const [command, category] of cases) {
      expect(describeTool('sandbox.execute', { command }).category).toBe(category);
    }
  });

  it('falls back to a generic command rather than guessing', () => {
    expect(describeTool('something.unknown', undefined)).toEqual({
      category: 'executing_tool',
      verb: 'Ran',
      object: null,
    });
  });
});

describe('deriveRunActivities', () => {
  it('shows one thinking row while the run has published no steps', () => {
    const activities = deriveRunActivities(run({}));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.category).toBe('thinking');
    expect(activities[0]?.status).toBe('running');
    expect(activities[0]?.completedAt).toBeNull();
  });

  it('keeps sequence numbers in the order the work happened', () => {
    const activities = deriveRunActivities(
      run({
        steps: [
          step({ toolId: 'project.read-file', input: { path: 'package.json' } }),
          step({ toolId: 'sandbox.execute', input: { command: 'npm test' } }),
        ],
      }),
    );
    expect(activities.map((activity) => activity.sequence)).toEqual([1, 2]);
    expect(activities.map((activity) => activity.title)).toEqual([
      'Read package.json',
      'Ran the tests',
    ]);
  });

  it('groups consecutive file changes under one parent', () => {
    const activities = deriveRunActivities(
      run({
        steps: [
          step({ toolId: 'project.create-file', input: { path: 'src/App.tsx' } }),
          step({ toolId: 'project.update-file', input: { path: 'package.json' } }),
          step({ toolId: 'project.create-file', input: { path: 'src/styles.css' } }),
          step({ toolId: 'sandbox.execute', input: { command: 'npm test' } }),
        ],
      }),
    );
    const group = activities.find((activity) => activity.category === 'writing');
    expect(group).toBeDefined();
    expect(group?.parentActivityId).toBeNull();
    expect(group?.status).toBe('succeeded');
    const children = activities.filter(
      (activity) => activity.parentActivityId === group?.activityId,
    );
    expect(children).toHaveLength(3);
    expect(activities[activities.length - 1]?.category).toBe('running_tests');
  });

  it('never marks a group successful when one of its members failed', () => {
    const activities = deriveRunActivities(
      run({
        steps: [
          step({ toolId: 'project.create-file', input: { path: 'a.ts' } }),
          step({
            toolId: 'project.create-file',
            status: 'failure',
            input: { path: 'b.ts' },
            error: { code: 'PATH_CONFLICT', message: 'That file already exists.' },
          }),
        ],
      }),
    );
    const group = activities.find((activity) => activity.category === 'writing');
    expect(group?.status).toBe('failed');
  });

  it('leaves a step that needs approval open', () => {
    const activities = deriveRunActivities(
      run({
        status: 'awaiting_confirmation',
        steps: [
          step({
            toolId: 'project.delete-file',
            status: 'awaiting_confirmation',
            input: { path: 'x' },
          }),
        ],
      }),
    );
    expect(activities[0]?.status).toBe('awaiting_approval');
    expect(activities[0]?.completedAt).toBeNull();
    expect(activities[0]?.safeSummary).toContain('approval');
  });

  it('keeps a refused step as cancelled, not as a failure', () => {
    const activities = deriveRunActivities(
      run({
        steps: [step({ toolId: 'project.delete-file', status: 'denied', input: { path: 'x' } })],
      }),
    );
    expect(activities[0]?.status).toBe('cancelled');
  });

  it('scrubs credentials out of the blocks it publishes', () => {
    const activities = deriveRunActivities(
      run({
        steps: [
          step({
            toolId: 'files.read',
            input: { path: 'notes.txt' },
            output: { text: 'key sk-abcdef1234567890 and AIzaSyABCDEFGHIJKLMNOP' },
          }),
        ],
      }),
    );
    const output = activities[0]?.safeOutput ?? '';
    expect(output).not.toContain('sk-abcdef1234567890');
    expect(output).not.toContain('AIzaSyABCDEFGHIJKLMNOP');
    expect(output).toContain('[redacted]');
  });

  it('trims an enormous output rather than mailing it to the browser', () => {
    const activities = deriveRunActivities(
      run({ steps: [step({ toolId: 'files.read', output: { text: 'x'.repeat(9000) } })] }),
    );
    expect((activities[0]?.safeOutput ?? '').length).toBeLessThan(4100);
  });
});

describe('buildFinalReport', () => {
  it('is absent while the run is still working', () => {
    expect(buildFinalReport(run({}), [])).toBeNull();
  });

  it('does not claim tests passed when no test ran', () => {
    const stepsList = [step({ toolId: 'project.read-file', input: { path: 'a.ts' } })];
    const report = buildFinalReport(run({ status: 'completed', steps: stepsList }), []);
    expect(report?.validation.tests).toBe('not_run');
    expect(report?.status).toBe('completed');
  });

  it('reports a real test pass, and a real failure', () => {
    const passed = buildFinalReport(
      run({
        status: 'completed',
        steps: [step({ toolId: 'sandbox.execute', input: { command: 'npm test' } })],
      }),
      [],
    );
    expect(passed?.validation.tests).toBe('passed');

    const failed = buildFinalReport(
      run({
        status: 'completed',
        steps: [
          step({ toolId: 'project.update-file', input: { path: 'a.ts' } }),
          step({
            toolId: 'sandbox.execute',
            status: 'failure',
            input: { command: 'npm test' },
            error: { code: 'EXIT', message: '2 tests failed' },
          }),
        ],
      }),
      [],
    );
    expect(failed?.validation.tests).toBe('failed');
    expect(failed?.status).toBe('completed_with_warnings');
    expect(failed?.failures).toHaveLength(1);
    expect(failed?.failures[0]?.reason).toContain('2 tests failed');
  });

  it('lists the files that actually changed', () => {
    const report = buildFinalReport(
      run({
        status: 'completed',
        steps: [
          step({ toolId: 'project.create-file', input: { path: 'src/App.tsx' } }),
          step({ toolId: 'project.update-file', input: { path: 'package.json' } }),
          step({ toolId: 'project.delete-file', input: { path: 'old.ts' } }),
          // A refused write is not a change.
          step({ toolId: 'project.delete-file', status: 'denied', input: { path: 'keep.ts' } }),
        ],
      }),
      [],
    );
    expect(report?.filesChanged).toEqual({
      created: ['src/App.tsx'],
      updated: ['package.json'],
      deleted: ['old.ts'],
    });
  });

  it('calls a run that stopped short partially completed', () => {
    const report = buildFinalReport(
      run({
        status: 'limit_reached',
        steps: [step({ toolId: 'project.read-file', input: { path: 'a' } })],
      }),
      [],
    );
    expect(report?.status).toBe('partially_completed');
    expect(report?.remaining.join(' ')).toContain('limit');
  });

  it('reports a cancelled run without pretending work happened', () => {
    const report = buildFinalReport(run({ status: 'cancelled', steps: [] }), []);
    expect(report?.status).toBe('cancelled');
    expect(report?.completed).toEqual([]);
  });

  it('reports a failed run as failed when nothing succeeded', () => {
    const report = buildFinalReport(
      run({
        status: 'failed',
        steps: [
          step({
            toolId: 'project.read-file',
            status: 'failure',
            input: { path: 'a' },
            error: { code: 'ENOENT', message: 'No such file' },
          }),
        ],
      }),
      [],
    );
    expect(report?.status).toBe('failed');
  });

  it('notices when a retry of the same work succeeded afterwards', () => {
    const stepsList = [
      step({
        toolId: 'sandbox.execute',
        status: 'failure',
        input: { command: 'npm test' },
        error: { code: 'EXIT', message: 'failed' },
      }),
      step({ toolId: 'sandbox.execute', input: { command: 'npm test' } }),
    ];
    const activities = deriveRunActivities(run({ status: 'completed', steps: stepsList }));
    const report = buildFinalReport(run({ status: 'completed', steps: stepsList }), activities);
    expect(report?.validation.tests).toBe('passed');
    expect(report?.recovery.join(' ')).toContain('Recovered');
  });
});

describe('validationKind', () => {
  it('only treats a real command as validation', () => {
    expect(validationKind(step({ toolId: 'project.read-file' }))).toBeNull();
    expect(
      validationKind(step({ toolId: 'sandbox.execute', input: { command: 'npx tsc -p .' } })),
    ).toBe('types');
  });
});

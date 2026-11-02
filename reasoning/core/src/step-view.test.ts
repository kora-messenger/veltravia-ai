import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHARS, toRunView, toStepView } from './step-view.js';
import type { ReasoningToolStep } from './engine.js';

const step = (over: Partial<ReasoningToolStep> = {}): ReasoningToolStep => ({
  stepId: 's1',
  toolId: 'project.read-file',
  intent: 'read the readme',
  status: 'success',
  input: { path: 'README.md' },
  output: { bytes: 42, text: 'hello' },
  requestedAt: '2026-11-02T15:00:00.000Z',
  completedAt: '2026-11-02T15:00:00.250Z',
  ...over,
});

describe('a step becomes a view the browser can render', () => {
  it('renames the engine statuses the interface draws', () => {
    expect(toStepView(step({ status: 'failure' })).status).toBe('failed');
    expect(toStepView(step({ status: 'denied' })).status).toBe('rejected');
    expect(toStepView(step()).status).toBe('success');
  });

  it('carries the engine id and a real duration', () => {
    const view = toStepView(step());
    expect(view.id).toBe('s1');
    expect(view.durationMs).toBe(250);
  });

  it('shows the tool and its arguments as a command', () => {
    expect(toStepView(step()).command).toBe('project.read-file\n{\n  "path": "README.md"\n}');
  });

  it('keeps the tool name alone when the step had no arguments', () => {
    expect(toStepView(step({ input: {} })).command).toBe('project.read-file');
  });

  it('shows no command for a step that recorded no arguments', () => {
    const { input: _input, ...rest } = step();
    expect(toStepView(rest as ReasoningToolStep).command).toBeNull();
  });

  it('puts a failure reason in the output slot', () => {
    const view = toStepView(
      step({
        status: 'failure',
        output: undefined,
        error: { code: 'TOOL_FAILED', message: 'The file does not exist.' },
      }),
    );
    expect(view.output).toContain('The file does not exist.');
  });

  it('says plainly that a step returned nothing', () => {
    const view = toStepView(step({ output: undefined }));
    expect(view.output).toBeNull();
  });

  it('scrubs a credential a tool echoed back', () => {
    const view = toStepView(step({ output: { token: 'sk-abcdefghijklmnop' } }));
    expect(view.output).not.toContain('sk-abcdefghijklmnop');
    expect(view.output).toContain('[redacted]');
  });

  it('bounds a huge output and marks it as cut', () => {
    const view = toStepView(step({ output: { text: 'x'.repeat(MAX_OUTPUT_CHARS * 2) } }));
    expect(view.truncated).toBe(true);
    expect(view.output?.length).toBeLessThan(MAX_OUTPUT_CHARS + 40);
  });

  it('narrows only the steps of a run', () => {
    const run = { id: 'r1', status: 'completed' as const, steps: [step()] };
    const view = toRunView(run);
    expect(view.id).toBe('r1');
    expect(view.status).toBe('completed');
    expect(view.steps[0]?.command).toContain('README.md');
  });
});

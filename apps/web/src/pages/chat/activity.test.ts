import { describe, expect, it } from 'vitest';
import { describeActivity, formatDuration, shorten } from './activity';
import type { ReasoningRunView } from '../../api/reasoning';
import { readCapabilities } from './useChat';

const run = (overrides: Partial<ReasoningRunView> = {}): ReasoningRunView => ({
  id: 'run-1',
  profile: 'workspace',
  task: 'Find the failing test',
  status: 'running',
  steps: [],
  decisions: [],
  usage: {
    iterations: 1,
    toolCalls: 0,
    modelCalls: 1,
    inputTokens: null,
    outputTokens: null,
    providerLatencyMs: 10,
    latencyMs: 12,
  },
  provenance: [],
  contextDropped: [],
  limitations: [],
  createdAt: '2026-11-02T12:00:00.000Z',
  ...overrides,
});

const step = (
  id: string,
  intent: string,
  status: 'success' | 'failed' | 'rejected' | 'pending_confirmation' = 'success',
  durationMs?: number,
) => ({
  id,
  toolId: 'codebase.search',
  intent,
  status,
  ...(durationMs === undefined ? {} : { durationMs }),
});

describe('the status line follows the run, not a guess', () => {
  it('says plainly that it is working when the run has published nothing', () => {
    const activity = describeActivity(run());
    expect(activity.label).toBe('Working on it');
    expect(activity.steps).toHaveLength(0);
    expect(activity.running).toBe(true);
  });

  it('holds the neutral line while only a plan exists', () => {
    const activity = describeActivity(
      run({ plan: { goal: 'Answer', steps: [{ intent: 'read the test tail' }] } }),
    );
    expect(activity.label).toBe('Working on it');
    expect(activity.label).not.toContain('Read the test tail');
  });

  it('never previews a planned step in the line', () => {
    const activity = describeActivity(
      run({ plan: { goal: 'Answer', steps: [{ intent: 'read the test tail' }] } }),
    );
    expect(activity.label.toLowerCase()).not.toContain('next');
  });

  it('prefers the last executed step over the plan', () => {
    const activity = describeActivity(
      run({
        plan: { goal: 'Answer', steps: [{ intent: 'first plan step' }] },
        steps: [step('s1', 'mapped the workspace'), step('s2', 'read the failing test tail')],
      }),
    );
    expect(activity.label).toBe('Read the failing test tail');
    expect(activity.steps.map((entry) => entry.label)).toEqual([
      'Mapped the workspace',
      'Read the failing test tail',
    ]);
  });

  it('keeps only the most recent steps, and keeps their order', () => {
    const steps = Array.from({ length: 20 }, (_, index) => step(`s${index}`, `step ${index}`));
    const activity = describeActivity(run({ steps }));
    expect(activity.steps).toHaveLength(12);
    expect(activity.steps[0]?.label).toBe('Step 8');
    expect(activity.steps[11]?.label).toBe('Step 19');
  });

  it('stops being "running" once the server says the run is over', () => {
    const activity = describeActivity(
      run({ status: 'completed', steps: [step('s1', 'read a file')] }),
    );
    expect(activity.running).toBe(false);
    expect(activity.label).toBe('Read a file');
  });

  it('never invents a label from an empty intent', () => {
    const activity = describeActivity(
      run({ plan: { goal: 'Answer', steps: [{ intent: '   ' }] } }),
    );
    expect(activity.label).toBe('Working on it');
  });
});

describe('label trimming', () => {
  it('collapses whitespace and keeps short labels intact', () => {
    expect(shorten('  read   the test  tail ')).toBe('read the test tail');
  });

  it('trims a long label at a word boundary with an ellipsis', () => {
    const long = 'a'.repeat(120);
    expect(shorten(long).length).toBeLessThanOrEqual(80);
    expect(shorten(long).endsWith('…')).toBe(true);
    const words = shorten(
      'reading the failing test tail in the workspace tree for the fourth time in this session today',
    );
    expect(words.endsWith('…')).toBe(true);
    expect(words).not.toContain('  ');
  });
});

describe('durations', () => {
  it('reads milliseconds below a second and seconds above', () => {
    expect(formatDuration(320)).toBe('320 ms');
    expect(formatDuration(1450)).toBe('1.5 s');
    expect(formatDuration(12400)).toBe('12 s');
  });

  it('shows nothing rather than a made-up number', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
  });
});

describe('a malformed capabilities reply', () => {
  it('is ignored instead of taking the screen down', () => {
    expect(readCapabilities(undefined)).toBeNull();
    expect(readCapabilities(null)).toBeNull();
    expect(readCapabilities({})).toBeNull();
    expect(readCapabilities({ provider: null })).toBeNull();
    expect(readCapabilities({ provider: { connected: 'yes', reason: null } })).toBeNull();
    expect(readCapabilities({ provider: { connected: false, reason: 42 } })).toBeNull();
  });

  it('is kept when the shape the page reads is there', () => {
    const value = { provider: { connected: false, reason: 'No provider connected.' }, tools: [] };
    expect(readCapabilities(value)).toBe(value);
  });
});

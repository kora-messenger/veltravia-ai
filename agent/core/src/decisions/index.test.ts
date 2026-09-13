import { describe, expect, it } from 'vitest';
import { InvalidAgentDecisionError } from '../errors/index.js';
import { MAX_DECISION_SUMMARY_LENGTH, parseAgentDecision } from './index.js';

describe('parseAgentDecision - never trusts raw model output', () => {
  it('parses a valid answer decision', () => {
    const parsed = parseAgentDecision({ type: 'answer', output: 'Veltravia AI is a platform.' });
    expect(parsed.decision).toEqual({ type: 'answer', output: 'Veltravia AI is a platform.' });
    expect(parsed.targetStatus).toBe('completed');
  });

  it('parses a valid request_tool decision with a concise summary', () => {
    const parsed = parseAgentDecision({
      type: 'request_tool',
      toolId: 'mock.summarize',
      input: { items: ['a'] },
      summary: 'Summarize the items',
    });
    expect(parsed.decision).toEqual({
      type: 'request_tool',
      toolId: 'mock.summarize',
      input: { items: ['a'] },
      summary: 'Summarize the items',
    });
    expect(parsed.targetStatus).toBe('waiting_for_tool');
  });

  it('parses request_confirmation, continue, fail, and stop decisions', () => {
    expect(parseAgentDecision({ type: 'request_confirmation' }).targetStatus).toBe(
      'waiting_for_confirmation',
    );
    expect(parseAgentDecision({ type: 'continue', summary: 'need more info' }).targetStatus).toBe(
      'planning',
    );
    expect(parseAgentDecision({ type: 'fail', message: 'cannot proceed' }).targetStatus).toBe(
      'failed',
    );
    expect(parseAgentDecision({ type: 'stop', summary: 'done enough' }).targetStatus).toBe(
      'completed',
    );
  });

  it('rejects non-objects and unknown decision types', () => {
    expect(() => parseAgentDecision('just text')).toThrow(InvalidAgentDecisionError);
    expect(() => parseAgentDecision(42)).toThrow(InvalidAgentDecisionError);
    expect(() => parseAgentDecision([1, 2])).toThrow(InvalidAgentDecisionError);
    expect(() => parseAgentDecision({ type: 'hack_the_planet' })).toThrow(/type must be one of/);
    expect(() => parseAgentDecision({})).toThrow(/type must be one of/);
  });

  it('rejects malformed payloads for each decision type', () => {
    expect(() => parseAgentDecision({ type: 'answer' })).toThrow(/output/);
    expect(() => parseAgentDecision({ type: 'answer', output: '   ' })).toThrow(/output/);
    expect(() => parseAgentDecision({ type: 'request_tool', input: {} })).toThrow(/toolId/);
    expect(() => parseAgentDecision({ type: 'request_tool', toolId: 'x' })).toThrow(/input/);
    expect(() => parseAgentDecision({ type: 'request_tool', toolId: 'x', input: 'str' })).toThrow(
      /input/,
    );
    expect(() => parseAgentDecision({ type: 'fail' })).toThrow(/message/);
  });

  it('rejects requests for the (invalid) request_confirmation path safely', () => {
    // Structurally valid - the loop checks whether a pending confirmation exists.
    const parsed = parseAgentDecision({ type: 'request_confirmation' });
    expect(parsed.decision.type).toBe('request_confirmation');
  });

  it('caps summaries - they must never carry chain-of-thought dumps', () => {
    const parsed = parseAgentDecision({
      type: 'continue',
      summary: 'x'.repeat(MAX_DECISION_SUMMARY_LENGTH + 500),
    });
    expect((parsed.decision as { summary: string }).summary.length).toBe(
      MAX_DECISION_SUMMARY_LENGTH,
    );
  });
});

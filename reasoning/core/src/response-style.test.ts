import { describe, expect, it } from 'vitest';

import { ReasoningEngine, RESPONSE_STYLE, ANSWER_FIELD_NOTE } from '@veltravia/reasoning-core';
import { SimulatedReasoningProvider } from '@veltravia/reasoning-mock';

/**
 * How the answer reads is part of the product. Both steps that write words for
 * the person carry the same guide, so a structured engineer's answer and a plain
 * one-line reply are two settings of one policy rather than two prompts that can
 * drift apart.
 */

const NOW = () => new Date('2026-10-31T12:00:00.000Z');

async function systems(): Promise<readonly string[]> {
  const provider = new SimulatedReasoningProvider({
    replies: [
      {
        content: JSON.stringify({
          taskType: 'question',
          needsTools: false,
          rationale: 'Classified.',
        }),
      },
      {
        content: JSON.stringify({
          type: 'answer',
          answer: 'Done.',
          complete: true,
          summary: 'Done.',
        }),
      },
      { content: 'Done.' },
    ],
  });
  const engine = new ReasoningEngine({ provider, now: NOW });
  await engine.run({ profile: 'workspace', task: 'Explain the change.' });
  return provider.requests.map((request) => request.system);
}

describe('the response guide', () => {
  it('tells both answer steps that their words are rendered as Markdown', async () => {
    // Step 1 is classification and writes nothing a person reads, so it carries
    // no style guide. Steps 3 and 4 both do.
    const answering = (await systems()).filter(
      (system) => system.includes('Step 3') || system.includes('Step 4'),
    );
    expect(answering).toHaveLength(2);
    for (const system of answering) {
      expect(system).toContain('Write the answer in Markdown');
    }
  });

  it('asks for length that matches the question, not a template', () => {
    expect(RESPONSE_STYLE.join('\n')).toMatch(/simple question gets a direct answer/);
    expect(RESPONSE_STYLE.join('\n')).toMatch(/no headings and no bullet list/);
  });

  it('asks for the four states of a work report to stay distinct', () => {
    const guide = RESPONSE_STYLE.join('\n');
    for (const state of ['Completed', 'In progress', 'Failed', 'Awaiting confirmation']) {
      expect(guide).toContain(state);
    }
  });

  it('forbids claiming unverified success and forbid repeating the question', () => {
    const guide = RESPONSE_STYLE.join('\n');
    expect(guide).toContain('Never claim something succeeded unless');
    expect(guide).toContain('Do not open with a greeting');
  });

  it('no longer bans code fences or structure in the final step', async () => {
    const all = (await systems()).join('\n');
    expect(all).not.toContain('no code fences');
  });

  it('tells the JSON answer field how to keep its line breaks', () => {
    expect(ANSWER_FIELD_NOTE).toContain('\\n');
  });

  it('keeps the untrusted-data boundary ahead of any style rule', async () => {
    for (const system of await systems()) {
      expect(system).toContain('UNTRUSTED DATA');
      expect(system.indexOf('UNTRUSTED DATA')).toBeLessThan(
        system.includes('Write the answer in Markdown')
          ? system.indexOf('Write the answer in Markdown')
          : Infinity,
      );
    }
  });
});

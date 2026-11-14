import { describe, expect, it } from 'vitest';

import {
  ReasoningEngine,
  ReasoningError,
  clipAnswer,
  LIMITS,
  trimBlankEdges,
} from '@veltravia/reasoning-core';
import { SimulatedReasoningProvider } from '@veltravia/reasoning-mock';

/**
 * A task has no length ceiling of its own. A pasted brief is as valid as a short
 * question, and nothing about the text is altered on the way to the model.
 */

const NOW = () => new Date('2026-10-31T12:00:00.000Z');

function engineWith(answerText: string) {
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
          answer: answerText,
          complete: true,
          summary: 'Done.',
        }),
      },
    ],
  });
  return { provider, engine: new ReasoningEngine({ provider, now: NOW }) };
}

function brief(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Requirement ${i}: the interface must stay responsive.`,
  ).join('\n\n');
}

describe('task length', () => {
  it('accepts a brief far longer than the old 4,000-character ceiling', async () => {
    const task = brief(2_000);
    expect(task.length).toBeGreaterThan(100_000);
    const { engine } = engineWith('done');
    const run = await engine.run({ profile: 'workspace', task });
    expect(run.status).toBe('completed');
    expect(run.task).toBe(task);
  });

  it('hands the model the whole task, character for character', async () => {
    const task = 'Heading\n\n- one\n  - nested\n\n```ts\nconst a = 1;\n```';
    const { provider, engine } = engineWith('done');
    await engine.run({ profile: 'workspace', task });
    const sent = provider.requests.map((request) =>
      request.messages.map((m) => m.content).join('\n'),
    );
    expect(sent.some((content) => content.includes(task))).toBe(true);
  });

  it('still refuses an empty task, and one that is only blank lines', async () => {
    const { engine } = engineWith('done');
    await expect(engine.run({ profile: 'workspace', task: '' })).rejects.toMatchObject({
      code: 'REASONING_INVALID_REQUEST',
    });
    await expect(engine.run({ profile: 'workspace', task: ' \n\t\n ' })).rejects.toBeInstanceOf(
      ReasoningError,
    );
  });

  it("keeps the first line's indentation rather than trimming it away", async () => {
    const { engine } = engineWith('done');
    const run = await engine.run({ profile: 'workspace', task: '\n\n    indented\nrest\n\n' });
    expect(run.task).toBe('    indented\nrest');
  });
});

describe('answer length', () => {
  it('leaves an ordinary answer untouched', () => {
    expect(clipAnswer('short')).toBe('short');
  });

  it('marks a cut instead of silently shortening a long one', () => {
    const long = 'x'.repeat(LIMITS.answer + 500);
    const clipped = clipAnswer(long);
    expect(clipped.length).toBeGreaterThan(LIMITS.answer);
    expect(clipped).toContain('was cut here');
    expect(clipped.startsWith('x'.repeat(1000))).toBe(true);
  });

  it('uses a large ceiling, so a document-sized answer survives', () => {
    expect(LIMITS.answer).toBeGreaterThanOrEqual(100_000);
  });
});

describe('edge trimming shared by every surface', () => {
  it('drops blank edge lines and trailing space, and nothing else', () => {
    expect(trimBlankEdges('\n \n  a\n\n  b  \n\n')).toBe('  a\n\n  b');
  });

  it('unifies CRLF without touching the text', () => {
    expect(trimBlankEdges('a\r\n\r\nb')).toBe('a\n\nb');
  });
});

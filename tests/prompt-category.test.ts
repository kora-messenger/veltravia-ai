import { describe, expect, it } from 'vitest';

import { classifyPrompt } from '../apps/api/src/prompt-category.js';

describe('classifyPrompt', () => {
  it.each([
    'hi',
    'What is the capital of Nigeria?',
    'Write a short thank-you note to my landlord.',
    'Give me three name ideas for a bakery.',
    'Translate "good morning" to French.',
    '',
  ])('treats %j as ordinary conversation', (prompt) => {
    expect(classifyPrompt(prompt)).toBe('general-conversation');
  });

  it.each([
    'Why does this throw? ```ts\nconst x = await fetch(url)\n```',
    'Fix the bug in my React component',
    'Write a Python script that renames files',
    'How do I write a SQL query to join two tables?',
    'TypeError: cannot read properties of undefined',
    'const total = items.reduce((a, b) => a + b, 0) is returning NaN',
    'Set up a Docker container for my node app',
  ])('sends %j to coding', (prompt) => {
    expect(classifyPrompt(prompt)).toBe('coding');
  });

  it.each([
    'Compare renting versus buying a house in Lagos and tell me the trade-offs.',
    'Analyze why my startup is losing users and decide between two strategies.',
    'Explain why the Roman empire fell, step by step.',
  ])('sends %j to complex reasoning', (prompt) => {
    expect(classifyPrompt(prompt)).toBe('complex-reasoning');
  });

  it('treats a prompt with three separate questions as multi-part reasoning', () => {
    expect(classifyPrompt('Who won? When was it? Where was it held?')).toBe('complex-reasoning');
  });

  it('treats a very long message as reasoning, not small talk', () => {
    expect(classifyPrompt('I have been thinking about my week. '.repeat(30))).toBe(
      'complex-reasoning',
    );
  });

  it('sends a question about an attached picture to image understanding', () => {
    expect(classifyPrompt('What is in this image?')).toBe('image-understanding');
    expect(classifyPrompt('Describe the attached screenshot')).toBe('image-understanding');
  });

  it('always treats a run with an image as image understanding', () => {
    expect(classifyPrompt('thoughts?', { hasImage: true })).toBe('image-understanding');
    expect(classifyPrompt('Fix this code', { hasImage: true })).toBe('image-understanding');
  });

  it('prefers coding over reasoning when both appear', () => {
    expect(classifyPrompt('Compare two ways to write this function in TypeScript')).toBe('coding');
  });

  it.each([
    'What is a code of conduct?',
    'What is the dress code for a wedding?',
    'Find the zip code for Victoria Island.',
  ])('does not mistake %j for a coding task', (prompt) => {
    expect(classifyPrompt(prompt)).toBe('general-conversation');
  });
});

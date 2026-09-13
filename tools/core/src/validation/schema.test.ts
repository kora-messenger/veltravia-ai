import { describe, expect, it } from 'vitest';
import { defineObjectSchema, validateToolObject } from './schema.js';

const summarySchema = defineObjectSchema({
  properties: {
    items: { type: 'array', items: { type: 'string', minLength: 1 } },
    joiner: { type: 'string', maxLength: 8 },
    limit: { type: 'number', minimum: 0, maximum: 100 },
    mode: { type: 'string', enum: ['fast', 'deep'] },
    nested: {
      type: 'object',
      properties: { label: { type: 'string' } },
      requiredFields: ['label'],
      additionalProperties: false,
    },
  },
  required: ['items'],
  additionalProperties: false,
});

describe('defineObjectSchema', () => {
  it('creates a validated schema and rejects malformed ones', () => {
    expect(() => defineObjectSchema({ properties: {} })).toThrow(/at least one field/);
    expect(() =>
      defineObjectSchema({ properties: { a: { type: 'string' } }, required: ['missing'] }),
    ).toThrow(/not declared/);
    expect(() => defineObjectSchema({ properties: { a: { type: 'mystery' as never } } })).toThrow(
      /unknown type/,
    );
    expect(() => defineObjectSchema({ properties: { a: { type: 'array' } } })).toThrow(
      /items schema/,
    );
    expect(() => defineObjectSchema({ properties: { a: { type: 'object' } } })).toThrow(
      /properties map/,
    );
  });
});

describe('validateToolObject', () => {
  it('accepts a valid input', () => {
    const problems = validateToolObject(summarySchema, {
      items: ['a', 'b'],
      joiner: ', ',
      limit: 5,
      mode: 'fast',
      nested: { label: 'x' },
    });
    expect(problems).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const problems = validateToolObject(summarySchema, { joiner: ' ' });
    expect(problems).toEqual(['input.items: required field is missing']);
  });

  it('rejects wrong types with field paths (never values)', () => {
    const problems = validateToolObject(summarySchema, { items: 'not-an-array', limit: 'ten' });
    expect(problems).toContain('input.items: expected array, got string');
    expect(problems).toContain('input.limit: expected number, got string');
    // Security: problems must not echo the input values.
    expect(problems.join(' ')).not.toContain('not-an-array');
    expect(problems.join(' ')).not.toContain('ten');
  });

  it('rejects malformed input (non-object)', () => {
    expect(validateToolObject(summarySchema, null)).toEqual(['input: expected an object']);
    expect(validateToolObject(summarySchema, [1, 2])).toEqual(['input: expected an object']);
    expect(validateToolObject(summarySchema, 'string')).toEqual(['input: expected an object']);
  });

  it('rejects unexpected fields when additionalProperties is false', () => {
    const problems = validateToolObject(summarySchema, { items: [], surprise: 'nope' });
    expect(problems).toEqual(['input.surprise: unexpected field']);
  });

  it('enforces enum, length, range, array-item, and nested-object rules', () => {
    const problems = validateToolObject(summarySchema, {
      items: ['ok', ''],
      joiner: 'way-too-long-joiner',
      limit: 500,
      mode: 'turbo',
      nested: { wrong: 'field' },
    });
    expect(problems).toContain('input.items[1]: string is too short (minimum 1)');
    expect(problems).toContain('input.joiner: string is too long (maximum 8)');
    expect(problems).toContain('input.limit: number is above the maximum');
    expect(problems).toContain('input.mode: value is not in the allowed set');
    expect(problems).toContain('input.nested.label: required field is missing');
    expect(problems).toContain('input.nested.wrong: unexpected field');
  });

  it('allows optional fields to be absent', () => {
    expect(validateToolObject(summarySchema, { items: [] })).toEqual([]);
  });
});

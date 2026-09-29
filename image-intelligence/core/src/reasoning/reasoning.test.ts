import { describe, expect, it } from 'vitest';
import {
  parseProviderJson,
  parseDescription,
  parseOcrResult,
  parseQueryResult,
  parseScreenshotAnalysis,
  parseUiStructure,
  parseDiagramAnalysis,
  parseComparisonResult,
  parseExtraction,
} from './index.js';
import { ImageIntelligenceError } from '../errors/index.js';

const fileId = 'file_1' as never;
const key = 'checksum-abc';
const realRegions = new Set(['r_real']);

describe('reasoning parsers - strictness', () => {
  it('accepts only bare JSON objects', () => {
    expect(parseProviderJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseProviderJson('```json\n{"a":1}\n```')).toThrow(ImageIntelligenceError);
    expect(() => parseProviderJson('Sure! Here is the answer: {"a":1}')).toThrow(
      ImageIntelligenceError,
    );
    expect(() => parseProviderJson('[1,2]')).toThrow(ImageIntelligenceError);
    expect(() => parseProviderJson('')).toThrow(ImageIntelligenceError);
    expect(() => parseProviderJson('not json at all')).toThrow(ImageIntelligenceError);
  });

  it('requires the mandatory summary/answer fields', () => {
    expect(() => parseDescription('{"observed":[]}', 'p', fileId)).toThrow(ImageIntelligenceError);
    expect(() => parseQueryResult('{"observed":[]}', 'p', fileId, 'q')).toThrow(
      ImageIntelligenceError,
    );
    expect(() => parseOcrResult('{"text":"x"}', 'p', fileId, key, null, 'now', 1000)).toThrow(
      ImageIntelligenceError,
    );
  });
});

describe('reasoning parsers - trust and bounds', () => {
  it('tags description as ai_generated with facts separated from inferences', () => {
    const d = parseDescription(
      '{"summary":"A chart.","observed":["four bars"],"inferences":["growth"]}',
      'p',
      fileId,
    );
    expect(d.trust).toBe('ai_generated');
    expect(d.observed).toEqual(['four bars']);
    expect(d.inferences).toEqual(['growth']);
  });

  it('normalizes OCR region ids to manager-owned ids and validates boxes', () => {
    const ocr = parseOcrResult(
      JSON.stringify({
        regions: [
          { text: 'Hello', box: [0.1, 0.1, 0.5, 0.2], confidence: 0.9, readingOrder: 1 },
          { text: 'World', box: [5, 5, 5, 5], confidence: 2 },
          { text: '' },
        ],
      }),
      'p',
      fileId,
      key,
      null,
      'now',
      100_000,
    );
    expect(ocr.trust).toBe('untrusted_data');
    expect(ocr.regions).toHaveLength(2);
    expect(ocr.regions[0]?.id).not.toBe('');
    // Invalid box (out of 0..1) is dropped to null, not trusted.
    expect(ocr.regions[1]?.box).toBeNull();
    expect(ocr.regions[1]?.confidence).toBeNull();
    // Reading order wins: 'World' has no order, 'Hello' sorts by readingOrder 1.
    expect(ocr.text).toContain('Hello');
    expect(ocr.text).toContain('World');
  });

  it('marks omitted data honestly when arrays are truncated', () => {
    const many = JSON.stringify({
      regions: Array.from({ length: 300 }, (_, i) => ({ text: `t${i}` })),
    });
    const ocr = parseOcrResult(many, 'p', fileId, key, null, 'now', 100_000);
    expect(ocr.regions.some((r) => r.text === 'OTHER-DATA-OMITTED')).toBe(true);
    const d = parseDescription(
      JSON.stringify({
        summary: 's',
        observed: Array.from({ length: 300 }, (_, i) => `o${i}`),
      }),
      'p',
      fileId,
    );
    expect(d.observed.some((o) => o === 'OTHER-DATA-OMITTED')).toBe(true);
  });

  it('drops forged region references from screenshot analysis', () => {
    const a = parseScreenshotAnalysis(
      JSON.stringify({
        issues: [
          { kind: 'overlap', statement: 'A overlaps B', basis: 'fact', regionId: 'r_real' },
          { kind: 'contrast', statement: 'low contrast', basis: 'inference', regionId: 'r_FORGED' },
          { kind: 'made_up_kind', statement: 'weird', basis: 'fact' },
        ],
      }),
      'p',
      fileId,
      realRegions,
    );
    expect(a.issues[0]?.regionId).toBe('r_real');
    expect(a.issues[1]?.regionId).toBeNull();
    // Unknown kinds fall back to 'other', never crash.
    expect(a.issues[2]?.kind).toBe('other');
  });

  it('drops forged region references and unknown kinds in UI structure', () => {
    const u = parseUiStructure(
      JSON.stringify({
        elements: [
          { kind: 'button', label: 'Save', regionId: 'r_real' },
          { kind: 'magic_widget', label: 'X', regionId: 'r_FORGED' },
        ],
      }),
      'p',
      fileId,
      key,
      realRegions,
    );
    expect(u.elements[0]?.regionId).toBe('r_real');
    expect(u.elements[1]?.kind).toBe('unknown');
    expect(u.elements[1]?.regionId).toBeNull();
    // The visual-evidence caveat is always present.
    expect(u.notes.some((n) => n.includes('not the original DOM'))).toBe(true);
  });

  it('drops diagram edges that connect forged node indexes', () => {
    const d = parseDiagramAnalysis(
      JSON.stringify({
        nodes: [
          { label: 'Client', kind: 'actor' },
          { label: 'API', kind: 'service' },
        ],
        relationships: [
          { fromIndex: 0, toIndex: 1, label: 'HTTPS', kind: 'sync' },
          { fromIndex: 99, toIndex: 0, label: 'forged', kind: 'forged' },
          { fromIndex: 1, toIndex: 99, label: 'forged2', kind: 'forged' },
        ],
      }),
      'p',
      fileId,
      key,
    );
    expect(d.nodes).toHaveLength(2);
    expect(d.relationships).toHaveLength(1);
    expect(d.relationships[0]?.fromId).toBe(d.nodes[0]?.id);
    expect(d.relationships[0]?.toId).toBe(d.nodes[1]?.id);
  });

  it('keeps comparison differences with kind fallback', () => {
    const c = parseComparisonResult(
      JSON.stringify({
        differences: [
          { kind: 'text_change', statement: 'title changed', basis: 'fact' },
          { kind: 'unknown_kind', statement: 'mystery' },
        ],
        summary: 'changed',
      }),
      'p',
      fileId,
      'file_2' as never,
    );
    expect(c.differences[0]?.kind).toBe('text_change');
    expect(c.differences[1]?.kind).toBe('other');
    expect(c.differences[1]?.basis).toBe('fact');
  });

  it('parses extraction with uncertainty flags', () => {
    const e = parseExtraction(
      JSON.stringify({
        fields: [
          { field: 'title', value: 'Report', uncertain: false },
          { field: 'count', value: '12', uncertain: true },
          { field: '', value: 'dropped' },
        ],
      }),
      'p',
      fileId,
    );
    expect(e.fields).toHaveLength(2);
    expect(e.fields[1]?.uncertain).toBe(true);
  });

  it('keeps the bounded question verbatim in query results', () => {
    const q = parseQueryResult(
      JSON.stringify({ answer: '42', insufficientEvidence: true }),
      'p',
      fileId,
      'how many widgets',
    );
    expect(q.question).toBe('how many widgets');
    expect(q.insufficientEvidence).toBe(true);
    expect(q.trust).toBe('ai_generated');
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseAnswer,
  parseComparison,
  parseEntities,
  parseProviderJson,
  parseSemanticSearch,
  parseSummary,
  validateEvidenceQuote,
} from './index.js';
import type { DocumentStructureView } from '../types/index.js';

const limits = {
  maxAnswerChars: 6000,
  maxEvidenceQuotes: 4,
  maxSearchMatches: 20,
  maxEntities: 40,
};

function structure(overrides: Partial<DocumentStructureView> = {}): DocumentStructureView {
  return {
    fileId: 'file-1' as never,
    format: 'docx',
    elements: [
      {
        id: 'file-1-el0',
        type: 'heading',
        text: 'Quarterly Report',
        level: 1,
        tableId: null,
        imageCount: null,
        linkUrl: null,
        ref: { kind: 'element', id: 'file-1-el0', label: 'Paragraph 1' },
      },
      {
        id: 'file-1-el1',
        type: 'paragraph',
        text: 'Revenue grew 32 percent to 4.5 million dollars.',
        level: null,
        tableId: null,
        imageCount: null,
        linkUrl: null,
        ref: { kind: 'element', id: 'file-1-el1', label: 'Paragraph 2' },
      },
    ],
    tables: [],
    sections: [],
    metadata: [],
    pageCount: null,
    slideCount: null,
    sheetCount: null,
    truncated: false,
    trustTag: 'untrusted_data',
    ...overrides,
  } as DocumentStructureView;
}

describe('parseProviderJson', () => {
  it('accepts a bare JSON object only', () => {
    expect(parseProviderJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseProviderJson('```json\n{"a":1}\n```')).toThrow();
    expect(() => parseProviderJson('Sure, here is the answer: {"a":1}')).toThrow();
    expect(() => parseProviderJson('[1,2]')).toThrow();
  });
});

describe('validateEvidenceQuote', () => {
  it('accepts text that exists in the document', () => {
    const quote = validateEvidenceQuote(
      structure(),
      'Revenue grew 32 percent to 4.5 million dollars.',
    );
    expect(quote?.ref.id).toBe('file-1-el1');
  });

  it('rejects text that is not in the document and oversized quotes', () => {
    expect(validateEvidenceQuote(structure(), 'Made up text')).toBeNull();
    expect(validateEvidenceQuote(structure(), 'x'.repeat(2001))).toBeNull();
  });
});

describe('parseAnswer', () => {
  it('keeps verified evidence and the provider confidence', () => {
    const view = parseAnswer(
      structure(),
      'How much did revenue grow?',
      {
        answer: 'Revenue grew 32 percent.',
        evidence: [{ quote: 'Revenue grew 32 percent to 4.5 million dollars.' }],
        confidence: 'high',
      },
      limits,
    );
    expect(view.evidence).toHaveLength(1);
    expect(view.confidence).toBe('high');
    expect(view.trustTag).toBe('ai_generated');
  });

  it('annotates an answer whose claimed evidence does not exist, and lowers confidence', () => {
    const view = parseAnswer(
      structure(),
      'Anything',
      {
        answer: 'Do something dangerous.',
        evidence: [{ quote: 'This sentence is not in the document.' }],
        confidence: 'high',
      },
      limits,
    );
    expect(view.evidence).toHaveLength(0);
    expect(view.answer).toContain('could be verified');
    expect(view.confidence).toBe('low');
  });

  it('fails closed on an empty answer', () => {
    expect(() => parseAnswer(structure(), 'q', { answer: '   ' }, limits)).toThrow();
  });
});

describe('parseSummary, parseEntities, parseComparison, parseSemanticSearch', () => {
  it('parses summaries of every mode', () => {
    const view = parseSummary(structure(), 'bullets', { summary: '- one\n- two' }, limits);
    expect(view.mode).toBe('bullets');
    expect(view.summary).toContain('- one');
  });

  it('caps and validates entity items', () => {
    const view = parseEntities(
      structure(),
      {
        entities: [
          { name: 'Acme', type: 'organization' },
          { name: '', type: 'person' },
          { name: 'Ada', type: 'not-a-type' },
        ],
      },
      limits,
    );
    expect(view.entities).toHaveLength(2);
    expect(view.entities[0]!.name).toBe('Acme');
    // an unrecognized type is recorded honestly as unknown, never echoed raw
    expect(view.entities[1]!.type).toBe('unknown');
  });

  it('requires a comparison summary', () => {
    expect(() =>
      parseComparison(structure(), structure({ fileId: 'file-2' as never }), {}, limits),
    ).toThrow();
    const view = parseComparison(
      structure(),
      structure({ fileId: 'file-2' as never }),
      { summary: 'They differ.', points: [{ label: 'Revenue', left: '4.5m', right: 'n/a' }] },
      limits,
    );
    expect(view.points).toHaveLength(1);
    expect(view.trustTag).toBe('ai_generated');
  });

  it('drops semantic matches whose references are not manager-owned', () => {
    const view = parseSemanticSearch(
      structure(),
      {
        matches: [
          { elementId: 'file-1-el1', score: 0.9 },
          { elementId: 'forged', score: 0.8 },
        ],
      },
      limits,
    );
    expect(view).toHaveLength(1);
    expect(view[0]!.elementId).toBe('file-1-el1');
  });
});

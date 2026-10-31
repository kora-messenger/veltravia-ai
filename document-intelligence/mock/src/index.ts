/** Deterministic, keyless mock document provider. Simulates document
 *  reasoning offline: answers quote only text genuinely present in the
 *  parsed structure, evidence is drawn from real elements, and nothing
 *  here represents real model quality. This is an honest development
 *  simulation, not a fake "AI". */
import type {
  DocumentProvider,
  DocumentProviderCapabilities,
  DocumentProviderRequest,
} from '@veltravia/document-intelligence-core';
import type { DocumentElement, DocumentStructureView } from '@veltravia/document-intelligence-core';

export const MOCK_DOCUMENT_PROVIDER_ID = 'mock.document';

export class MockDocumentProvider implements DocumentProvider {
  readonly id = MOCK_DOCUMENT_PROVIDER_ID;

  constructor(options: { readonly latencyMs?: number } = {}) {
    this.latencyMs = Math.max(0, Math.min(options.latencyMs ?? 0, 5000));
  }

  private readonly latencyMs: number;

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  getCapabilities(): DocumentProviderCapabilities {
    return {
      providerId: MOCK_DOCUMENT_PROVIDER_ID,
      capabilities: [
        'document_understanding',
        'question_answering',
        'summarization',
        'semantic_search',
        'entity_extraction',
        'comparison_reasoning',
        'ocr',
      ],
      simulated: true,
    };
  }

  async process(request: DocumentProviderRequest): Promise<string> {
    await this.delay();
    const structure = request.structure;
    const elements = structure.elements;
    switch (request.operation) {
      case 'process':
        return JSON.stringify({ ok: true, elementCount: elements.length });
      case 'answer': {
        const question = String(request.input.question ?? '');
        const corpus = elements.filter((e) => e.text.length > 0);
        if (corpus.length === 0) {
          return JSON.stringify({
            answer: 'The document contains no readable text to answer from.',
            evidence: [],
            confidence: 'low',
          });
        }
        // Honest simulation: find the element most relevant to the question
        // by token overlap; quote it verbatim as evidence.
        const tokens = question
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 2);
        let best: DocumentElement | null = null;
        let bestScore = 0;
        for (const element of corpus) {
          const text = element.text.toLowerCase();
          const score = tokens.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
          if (score > bestScore) {
            best = element;
            bestScore = score;
          }
        }
        const chosen = best ?? corpus[0];
        if (!chosen) {
          return JSON.stringify({ answer: '', evidence: [], confidence: 'low' });
        }
        const answer =
          bestScore > 0
            ? `Based on the document, the most relevant passage reads: "${chosen.text.slice(0, 400)}"`
            : 'The document does not appear to contain a passage relevant to the question.';
        return JSON.stringify({
          answer,
          evidence: [{ quote: chosen.text.slice(0, 400) }],
          confidence: bestScore > 1 ? 'medium' : 'low',
        });
      }
      case 'summarize': {
        const mode = String(request.input.mode ?? 'brief');
        const headings = elements.filter((e) => e.type === 'heading').slice(0, 6);
        const firstParagraphs = elements
          .filter((e) => e.type === 'paragraph')
          .slice(0, 3)
          .map((e) => e.text.slice(0, 200));
        if (mode === 'bullets') {
          const bullets = (headings.length > 0 ? headings : elements.slice(0, 5)).map(
            (e) => `- ${e.text.slice(0, 160)}`,
          );
          return JSON.stringify({
            summary:
              bullets.length > 0 ? bullets.join('\n') : '- The document has no readable content.',
          });
        }
        if (mode === 'executive') {
          return JSON.stringify({
            summary:
              `Executive summary (${structure.format}): ` +
              (headings.length > 0
                ? `covers ${headings.map((h) => h.text.slice(0, 80)).join(', ')}.`
                : `${elements.length} elements, no headings detected.`),
          });
        }
        return JSON.stringify({
          summary:
            `Brief summary (${structure.format}): ` +
            (firstParagraphs.length > 0
              ? firstParagraphs.join(' ')
              : 'no paragraph text was extracted from this document.'),
        });
      }
      case 'semantic-search': {
        const query = String(request.input.query ?? '').toLowerCase();
        const matches = elements
          .filter((e) => e.text.toLowerCase().includes(query))
          .slice(0, 20)
          .map((e) => ({ elementId: e.id, snippet: e.text.slice(0, 400), score: 1 }));
        return JSON.stringify({ matches });
      }
      case 'entities': {
        const text = elements.map((e) => e.text).join(' ');
        const found: { name: string; type: string }[] = [];
        const known: readonly { re: RegExp; type: string }[] = [
          { re: /\b(?:[A-Z][a-z]+ ){1,2}[A-Z][a-z]+\b/g, type: 'person-or-place' },
          { re: /\b\d{4}-\d{2}-\d{2}\b/g, type: 'date' },
          { re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, type: 'email' },
          { re: /\b\d+(?:\.\d+)?\b/g, type: 'number' },
        ];
        for (const { re, type } of known) {
          for (const m of text.matchAll(re)) {
            const name = (m[0] ?? '').trim();
            if (name && !found.some((f) => f.name === name)) found.push({ name, type });
            if (found.length >= 30) break;
          }
          if (found.length >= 30) break;
        }
        return JSON.stringify({ entities: found });
      }
      case 'compare': {
        const right = request.compareStructure;
        if (!right) {
          return JSON.stringify({ summary: '', points: [] });
        }
        const leftTitles = structure.elements
          .filter((e) => e.type === 'heading')
          .map((e) => e.text)
          .slice(0, 5);
        const rightTitles = right.elements
          .filter((e) => e.type === 'heading')
          .map((e) => e.text)
          .slice(0, 5);
        return JSON.stringify({
          summary: `The left document (${structure.format}) and right document (${right.format}) differ in content and structure.`,
          points: [
            { label: 'Format', left: structure.format, right: right.format },
            {
              label: 'Element count',
              left: String(structure.elements.length),
              right: String(right.elements.length),
            },
            {
              label: 'Headings',
              left: leftTitles.join('; ') || 'none',
              right: rightTitles.join('; ') || 'none',
            },
          ],
        });
      }
      case 'ocr': {
        // Honest simulation: joins genuinely extracted text; it cannot read
        // pixels of embedded images and says so when there is nothing.
        const text = elements
          .filter((e) => e.text.length > 0)
          .map((e) => e.text)
          .join('\n');
        return JSON.stringify({
          text: text.length > 0 ? text : 'No readable text was found in the document.',
        });
      }
      default:
        return JSON.stringify({ error: 'unknown operation' });
    }
  }
}

export function createMockDocumentProvider(
  options: { readonly latencyMs?: number } = {},
): DocumentProvider {
  return new MockDocumentProvider(options);
}

export type { DocumentStructureView };

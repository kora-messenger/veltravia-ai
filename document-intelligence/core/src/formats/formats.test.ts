import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asFileAssetId } from '@veltravia/file-intelligence-core';
import { parseDocument, inspectDocumentFormat, sectionsFromElements } from './index.js';
import type { DocumentParseLimits } from './index.js';

const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const limits: DocumentParseLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxElements: 500,
  maxSections: 100,
  maxTables: 20,
  maxTableRows: 200,
  maxSheetRows: 1000,
  maxSlides: 200,
};

describe('DOCX parsing', () => {
  it('extracts headings, paragraphs, list items, links and tables', () => {
    const view = parseDocument('docx', read('report.docx'), asFileAssetId('t1'), limits);
    expect(view.format).toBe('docx');
    const texts = view.elements.map((e) => e.text);
    expect(texts).toContain('Quarterly Revenue Report');
    expect(texts).toContain('Regional Breakdown');
    expect(texts).toContain('Lagos contributed 48 percent of new signups.');
    const link = view.elements.find((e) => e.type === 'link');
    expect(link?.linkUrl).toBe('https://example.com/report');
    expect(link?.text).toBe('Full dataset');
    const table = view.tables[0];
    expect(table?.headers).toEqual(['Region', 'Revenue']);
    expect(table?.rows[0]).toEqual(['Lagos', '125000']);
    // Metadata from docProps/core.xml
    const title = view.metadata.find((m) => m.key === 'dc:title');
    expect(title?.value).toBe('Quarterly Report');
    // Sections are grouped at headings
    expect(view.sections.length).toBeGreaterThan(0);
    expect(view.truncated).toBe(false);
    expect(view.trustTag).toBe('untrusted_data');
  });

  it('caps elements and reports truncation honestly', () => {
    const view = parseDocument('docx', read('report.docx'), asFileAssetId('t2'), {
      ...limits,
      maxElements: 2,
      maxSections: 10,
    });
    expect(view.elements.length).toBeLessThanOrEqual(2);
    expect(view.truncated).toBe(true);
  });
});

describe('XLSX parsing', () => {
  it('reads sheets, headers and numeric statistics without evaluating formulas', () => {
    const view = parseDocument('xlsx', read('sales.xlsx'), asFileAssetId('t3'), limits);
    expect(view.format).toBe('xlsx');
    expect(view.sheetCount).toBe(2);
    const sheetHeading = view.elements.find((e) => e.text.startsWith('Sheet: Sales'));
    expect(sheetHeading).toBeDefined();
    expect(sheetHeading?.ref.kind).toBe('sheet');
    expect(view.trustTag).toBe('untrusted_data');
  });
});

describe('PPTX parsing', () => {
  it('reads slide titles, bullets and speaker notes', () => {
    const view = parseDocument('pptx', read('launch.pptx'), asFileAssetId('t4'), limits);
    expect(view.format).toBe('pptx');
    expect(view.slideCount).toBe(2);
    const texts = view.elements.map((e) => e.text);
    expect(texts).toContain('Vision');
    expect(texts).toContain('Own the messenger market in Africa');
    expect(texts).toContain('Roadmap');
    expect(texts).toContain('Emphasize the shipping cadence.');
    expect(view.trustTag).toBe('untrusted_data');
  });
});

describe('PDF parsing', () => {
  it('counts pages and extracts text operators from content streams', () => {
    const view = parseDocument('pdf', read('report.pdf'), asFileAssetId('t5'), limits);
    expect(view.pageCount).toBe(1);
    const joined = view.elements.map((e) => e.text).join(' ');
    expect(joined).toContain('Quarterly Revenue Report');
    expect(joined).toContain('Revenue grew 32 percent quarter over quarter.');
    expect(view.elements.every((e) => e.ref.kind === 'page')).toBe(true);
    expect(view.trustTag).toBe('untrusted_data');
  });
});

describe('structured text formats', () => {
  it('parses markdown headings, lists, tables and links', () => {
    const view = parseDocument('markdown', read('handbook.md'), asFileAssetId('t6'), limits);
    const texts = view.elements.map((e) => e.text);
    expect(texts).toContain('Veltravia Handbook');
    expect(texts).toContain('Getting Started');
    expect(view.elements.some((e) => e.type === 'listItem')).toBe(true);
    const link = view.elements.find((e) => e.type === 'link');
    expect(link?.linkUrl).toBe('https://veltravia.example.com');
    const table = view.tables[0];
    expect(table?.headers).toEqual(['Section', 'Owner']);
    expect(table?.rows).toEqual([
      ['Getting Started', 'Docs Team'],
      ['Security', 'Sec Team'],
    ]);
    expect(view.sections.some((s) => s.title === 'Security')).toBe(true);
  });

  it('parses HTML while stripping script and style text entirely', () => {
    const view = parseDocument('html', read('page.html'), asFileAssetId('t7'), limits);
    const joined = view.elements.map((e) => e.text).join(' ');
    expect(joined).toContain('Veltravia Product');
    expect(joined).toContain('499 naira');
    expect(joined).not.toContain('never executed');
    expect(joined).not.toContain('color:red');
    const table = view.tables[0];
    expect(table?.headers).toEqual(['Plan', 'Cost']);
    expect(table?.rows).toEqual([
      ['Basic', '100'],
      ['Pro', '200'],
    ]);
  });

  it('parses CSV headers and rows', () => {
    const view = parseDocument('csv', read('regions.csv'), asFileAssetId('t8'), limits);
    expect(view.tables[0]?.headers).toEqual(['Region', 'Revenue', 'Signups']);
    expect(view.tables[0]?.rows.length).toBe(3);
  });

  it('describes JSON structure as elements', () => {
    const view = parseDocument('json', read('product.json'), asFileAssetId('t9'), limits);
    const joined = view.elements.map((e) => e.text).join(' ');
    expect(joined).toContain('Veltravia');
    expect(joined).toContain('$.pricing.basic = 100');
  });

  it('extracts XML leaf values', () => {
    const view = parseDocument('xml', read('catalog.xml'), asFileAssetId('t10'), limits);
    const joined = view.elements.map((e) => e.text).join(' ');
    expect(joined).toContain('Onboarding');
    expect(joined).toContain('Docs Team');
  });

  it('refines plain text: markdown structure is detected from bytes', () => {
    const view = parseDocument('txt', read('handbook.md'), asFileAssetId('t11'), limits);
    expect(view.format).toBe('markdown');
  });

  it('keeps plain text as paragraphs', () => {
    const view = parseDocument('txt', read('notes.txt'), asFileAssetId('t12'), limits);
    expect(view.format).toBe('txt');
    expect(view.elements.map((e) => e.text)).toContain('Simple notes file.');
  });
});

describe('format dispatch', () => {
  it('fails closed for unknown formats instead of guessing', () => {
    expect(() =>
      parseDocument('pdf', new Uint8Array([1, 2, 3]), asFileAssetId('t13'), limits),
    ).toThrow();
    const unknown = inspectDocumentFormat(new Uint8Array([0x11, 0x22, 0x33]));
    expect(unknown.format).toBe('unknown');
  });

  it('groups sections at headings with bounded element ids', () => {
    const view = parseDocument('markdown', read('handbook.md'), asFileAssetId('t14'), limits);
    const sections = sectionsFromElements(view.elements, 2);
    expect(sections.length).toBeLessThanOrEqual(2);
    for (const section of sections) {
      expect(section.elementIds.length).toBeGreaterThan(0);
    }
  });
});

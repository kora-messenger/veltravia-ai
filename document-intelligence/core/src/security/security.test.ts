import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertNoSecretShape,
  containsSecretShape,
  detectDocumentFormat,
  documentFormatFromZipEntries,
  refineTextFormat,
} from './index.js';
import { zipEntryPaths } from '../formats/zipreader.js';
import { inspectDocumentFormat } from '../formats/index.js';

const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

describe('magic-byte format detection', () => {
  it('detects PDF from the %PDF header', () => {
    expect(detectDocumentFormat(read('report.pdf'))).toBe('pdf');
    expect(inspectDocumentFormat(read('report.pdf')).format).toBe('pdf');
  });

  it('disambiguates OOXML containers by their internal entries', () => {
    expect(detectDocumentFormat(read('report.docx'))).toBe('zip-container');
    expect(inspectDocumentFormat(read('report.docx')).format).toBe('docx');
    expect(inspectDocumentFormat(read('sales.xlsx')).format).toBe('xlsx');
    expect(inspectDocumentFormat(read('launch.pptx')).format).toBe('pptx');
  });

  it('refuses a ZIP without OOXML markers', () => {
    expect(documentFormatFromZipEntries(['random/file.txt'])).toBe('unknown');
    expect(documentFormatFromZipEntries(['word/document.xml'])).toBe('docx');
    expect(documentFormatFromZipEntries(['xl/workbook.xml'])).toBe('xlsx');
    expect(documentFormatFromZipEntries(['ppt/presentation.xml'])).toBe('pptx');
  });

  it('returns unknown for non-document bytes, never a filename guess', () => {
    expect(detectDocumentFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(
      'unknown',
    );
    expect(detectDocumentFormat(new Uint8Array(0))).toBe('unknown');
    expect(inspectDocumentFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).format).toBe('unknown');
  });

  it('refines text bytes by structure, not by name', () => {
    expect(refineTextFormat('# Title\n\nBody')).toBe('markdown');
    expect(refineTextFormat('<html><body>x</body></html>')).toBe('html');
    expect(refineTextFormat('{"a":1}')).toBe('json');
    expect(refineTextFormat('a,b\n1,2')).toBe('csv');
    expect(refineTextFormat('<?xml version="1.0"?><a><b>1</b></a>')).toBe('xml');
    expect(refineTextFormat('just words')).toBe('txt');
    expect(inspectDocumentFormat(read('handbook.md')).format).toBe('markdown');
    expect(inspectDocumentFormat(read('regions.csv')).format).toBe('csv');
  });

  it('lists zip entry paths without inflating anything', () => {
    const paths = zipEntryPaths(read('report.docx'));
    expect(paths).toContain('word/document.xml');
    expect(paths).toContain('docProps/core.xml');
  });
});

describe('secret-shape rejection', () => {
  it('rejects secret-shaped text and accepts ordinary prose', () => {
    expect(containsSecretShape('sk-live-abcdefghijklmnop123456')).toBe(true);
    expect(containsSecretShape('api_key = "abcdef123456"')).toBe(true);
    expect(containsSecretShape('The revenue grew 32 percent.')).toBe(false);
    expect(() => assertNoSecretShape('ordinary', 'test')).not.toThrow();
    expect(() => assertNoSecretShape('sk-live-abcdefghijklmnop123456', 'test')).toThrow();
  });
});

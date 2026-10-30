/** Format dispatch: magic-byte detection, ZIP disambiguation and structural
 *  parsing into the shared DocumentStructureView. Unparseable files fail
 *  closed; nothing is guessed from filenames or MIME types. */
import { asFileAssetId } from '../types/index.js';
import {
  detectDocumentFormat,
  documentFormatFromZipEntries,
  refineTextFormat,
} from '../security/index.js';
import type {
  DocumentElement,
  DocumentSection,
  DocumentStructureView,
  DocumentFormat,
} from '../types/index.js';
import { readZipParts, zipEntryPaths } from './zipreader.js';
import { parseDocx } from './docx.js';
import { parseXlsx } from './xlsx.js';
import { parsePptx } from './pptx.js';
import { assertPdf, parsePdf } from './pdf.js';
import { parseStructured } from './structured.js';

export interface DocumentParseLimits {
  readonly maxFileBytes: number;
  readonly maxElements: number;
  readonly maxSections: number;
  readonly maxTables: number;
  readonly maxTableRows: number;
  readonly maxSheetRows: number;
  readonly maxSlides: number;
}

export interface InspectFormatResult {
  readonly format: DocumentFormat | 'unknown';
  readonly detectedFrom: 'magic-bytes';
}

/** Detect the format from magic bytes only. */
export function inspectDocumentFormat(bytes: Uint8Array): InspectFormatResult {
  const detected = detectDocumentFormat(bytes);
  if (detected === 'zip-container') {
    const format = documentFormatFromZipEntries(zipEntryPaths(bytes));
    return { format, detectedFrom: 'magic-bytes' };
  }
  if (detected === 'unknown') return { format: 'unknown', detectedFrom: 'magic-bytes' };
  if (detected === 'txt') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.slice(0, Math.min(bytes.length, 64 * 1024)),
    );
    return { format: refineTextFormat(text), detectedFrom: 'magic-bytes' };
  }
  return { format: detected, detectedFrom: 'magic-bytes' };
}

/** Parse a detected document into the bounded structural view. */
export function parseDocument(
  format: DocumentFormat,
  bytes: Uint8Array,
  fileIdRaw: string,
  limits: DocumentParseLimits,
): DocumentStructureView {
  const fileId = asFileAssetId(fileIdRaw);
  const common = { fileId, format, truncated: false };

  if (format === 'pdf') {
    assertPdf(bytes);
    const result = parsePdf(
      bytes,
      { maxElements: limits.maxElements, maxPages: limits.maxSlides },
      fileId,
    );
    const sections = sectionsFromElements(result.elements, limits.maxSections);
    return {
      ...common,
      elements: result.elements,
      tables: [],
      sections,
      metadata: result.metadata,
      pageCount: result.pageCount,
      slideCount: null,
      sheetCount: null,
      truncated: result.truncated,
      trustTag: 'untrusted_data',
    };
  }

  if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
    const paths = zipEntryPaths(bytes);
    const wanted = wantedParts(format, paths);
    const parts = readZipParts(bytes, wanted, 40 * 1024 * 1024);
    if (format === 'docx') {
      const result = parseDocx(parts, limits, fileId);
      const sections = sectionsFromElements(result.elements, limits.maxSections);
      return {
        ...common,
        elements: result.elements,
        tables: result.tables,
        sections,
        metadata: result.metadata,
        pageCount: null,
        slideCount: null,
        sheetCount: null,
        truncated: result.truncated,
        trustTag: 'untrusted_data',
      };
    }
    if (format === 'xlsx') {
      const result = parseXlsx(parts, {
        maxSheetRows: limits.maxSheetRows,
        maxElements: limits.maxTables,
      });
      const elements: DocumentElement[] = result.sheets
        .slice(0, limits.maxElements)
        .map((sheet, index) => {
          const id = `${fileId}-el${index}`;
          return {
            id,
            type: 'heading',
            text: `Sheet: ${sheet.name} (${sheet.rowCount} rows, ${sheet.columnCount} columns)`,
            level: 1,
            tableId: null,
            imageCount: null,
            linkUrl: null,
            ref: { kind: 'sheet', id: `sheet-${index + 1}`, label: sheet.name },
          };
        });
      return {
        ...common,
        elements,
        tables: [],
        sections: [],
        metadata: result.metadata,
        pageCount: null,
        slideCount: null,
        sheetCount: result.sheets.length,
        truncated: result.truncated,
        trustTag: 'untrusted_data',
      };
    }
    const result = parsePptx(parts, { maxSlides: limits.maxSlides }, fileId);
    return {
      ...common,
      elements: result.elements,
      tables: [],
      sections: [],
      metadata: result.metadata,
      pageCount: null,
      slideCount: result.slides.length,
      sheetCount: null,
      truncated: result.truncated,
      trustTag: 'untrusted_data',
    };
  }

  // Text-family formats.
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const effective = format === 'txt' ? refineTextFormat(raw) : format;
  const structuredFormat: 'csv' | 'markdown' | 'html' | 'json' | 'xml' | 'txt' =
    effective === 'csv' ||
    effective === 'markdown' ||
    effective === 'html' ||
    effective === 'json' ||
    effective === 'xml'
      ? effective
      : 'txt';
  const result = parseStructured(structuredFormat, raw, limits, fileId);
  const sections = sectionsFromElements(result.elements, limits.maxSections);
  return {
    ...common,
    format: effective,
    elements: result.elements,
    tables: result.tables,
    sections,
    metadata: result.metadata,
    pageCount: null,
    slideCount: null,
    sheetCount: null,
    truncated: result.truncated,
    trustTag: 'untrusted_data',
  };
}

/** Group elements into sections at headings. */
export function sectionsFromElements(
  elements: readonly DocumentElement[],
  maxSections: number,
): readonly DocumentSection[] {
  const sections: DocumentSection[] = [];
  let current: { id: string; title: string; elementIds: string[] } | null = null;
  const flush = (): void => {
    if (current && current.elementIds.length > 0 && sections.length < maxSections) {
      sections.push({
        id: current.id,
        title: current.title,
        elementIds: current.elementIds.slice(0, 500),
        ref: { kind: 'section', id: current.id, label: current.title || 'Untitled section' },
      });
    }
  };
  for (const element of elements) {
    if (sections.length >= maxSections) break;
    if (element.type === 'heading') {
      flush();
      current = {
        id: `section-${sections.length + 1}`,
        title: element.text,
        elementIds: [element.id],
      };
      continue;
    }
    if (!current) {
      current = { id: 'section-1', title: '', elementIds: [] };
    }
    current.elementIds.push(element.id);
  }
  flush();
  return sections;
}

function wantedParts(format: DocumentFormat, paths: readonly string[]): readonly string[] {
  const prefixes =
    format === 'docx'
      ? ['word/', 'docProps/']
      : format === 'xlsx'
        ? ['xl/', 'docProps/']
        : ['ppt/', 'docProps/'];
  return paths.filter((p) => prefixes.some((prefix) => p.startsWith(prefix))).slice(0, 200);
}

/** PPTX (PresentationML) parser: slide titles, bullet texts and notes.
 *  Presentation content is metadata and text only; embedded media is
 *  counted, never decoded; no part is ever executed. */
import type {
  DocumentElement,
  DocumentMetadataEntry,
  PresentationSlideView,
} from '../types/index.js';
import { partToText } from './shared.js';
import { findAll, findFirst, parseXml, type XmlNode } from './ooxml-helpers.js';

export interface PptxParseLimits {
  readonly maxSlides: number;
}

export interface PptxParseResult {
  readonly slides: readonly PresentationSlideView[];
  readonly elements: readonly DocumentElement[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly truncated: boolean;
}

export function parsePptx(
  parts: ReadonlyMap<string, Uint8Array>,
  limits: PptxParseLimits,
  fileId: string,
): PptxParseResult {
  const presentationBytes = parts.get('ppt/presentation.xml');
  if (!presentationBytes) throw new Error('ppt/presentation.xml missing');
  const presentation = parseXml(partToText(presentationBytes));

  const slideIds: string[] = [];
  for (const sld of findAll(presentation, 'p:sldId').slice(0, limits.maxSlides + 5)) {
    const id = sld.attrs['r:id'] ?? '';
    if (id) slideIds.push(id);
  }

  const relBytes = parts.get('ppt/_rels/presentation.xml.rels');
  const rels = relBytes ? relMap(partToText(relBytes)) : new Map<string, string>();

  const coreBytes = parts.get('docProps/core.xml');
  const metadata = coreBytes ? parseCore(partToText(coreBytes)) : [];

  const slides: PresentationSlideView[] = [];
  let truncated = false;

  for (const rid of slideIds) {
    if (slides.length >= limits.maxSlides) {
      truncated = true;
      break;
    }
    const target = rels.get(rid);
    const partName = target ? normalize(target) : null;
    const partBytes = partName ? parts.get(partName) : undefined;
    if (!partBytes || !partName) continue;
    const slide = parseSlide(
      slides.length,
      partToText(partBytes),
      partName.replace('slides/', '').replace('.xml', ''),
    );
    const notes = readNotes(parts, partName);
    slides.push({ ...slide, notes });
  }

  const elements: DocumentElement[] = [];
  slides.forEach((slide, index) => {
    const id = `${fileId}-el${elements.length}`;
    elements.push({
      id,
      type: 'heading',
      text: slide.title || `Slide ${index + 1}`,
      level: 1,
      tableId: null,
      imageCount: null,
      linkUrl: null,
      ref: { kind: 'slide', id: `slide-${index + 1}`, label: `Slide ${index + 1}` },
    });
    for (const bullet of slide.bulletTexts) {
      elements.push({
        id: `${fileId}-el${elements.length}`,
        type: 'listItem',
        text: bullet,
        level: null,
        tableId: null,
        imageCount: null,
        linkUrl: null,
        ref: { kind: 'slide', id: `slide-${index + 1}`, label: `Slide ${index + 1}` },
      });
    }
    if (slide.notes) {
      elements.push({
        id: `${fileId}-el${elements.length}`,
        type: 'paragraph',
        text: slide.notes,
        level: null,
        tableId: null,
        imageCount: null,
        linkUrl: null,
        ref: { kind: 'slide', id: `slide-${index + 1}`, label: `Slide ${index + 1}` },
      });
    }
  });

  return { slides, metadata, truncated, elements };
}

function normalize(target: string): string {
  const clean = target.replace(/^\.\//, '');
  return clean.startsWith('ppt/') ? clean : `ppt/${clean}`;
}

function readNotes(parts: ReadonlyMap<string, Uint8Array>, slidePartName: string): string {
  const relsPath = slidePartName
    .replace('ppt/slides/', 'ppt/slides/_rels/')
    .replace(/\.xml$/, '.xml.rels');
  const relBytes = parts.get(relsPath);
  if (!relBytes) return '';
  const rels = relMap(partToText(relBytes));
  for (const target of rels.values()) {
    if (!target.includes('notesSlide')) continue;
    const segments = target.split('/').filter((seg) => seg.length > 0);
    const resolved: string[] = slidePartName.split('/').slice(0, -1);
    for (const seg of segments) {
      if (seg === '.' || seg === '..') {
        resolved.pop();
        continue;
      }
      resolved.push(seg);
    }
    const notesName = resolved.join('/');
    const notesBytes = parts.get(notesName);
    if (!notesBytes) continue;
    const root = parseXml(partToText(notesBytes));
    const texts = findAll(root, 'a:t')
      .map((t) => (t.text ?? '').trim())
      .filter((t) => t.length > 0);
    return texts.join(' ').slice(0, 2000);
  }
  return '';
}

function parseSlide(index: number, xml: string, rawName: string): PresentationSlideView {
  const root = parseXml(xml);
  let title = '';
  const bullets: string[] = [];
  const shapes = findAll(root, 'p:sp').slice(0, 100);
  for (const sp of shapes) {
    const ph = findFirst(sp, 'p:ph');
    const phType = ph?.attrs['type'] ?? '';
    // One bullet per a:p paragraph, so multi-paragraph shapes stay distinct.
    const paragraphs = findAll(sp, 'a:p')
      .map((p) => collectText(p))
      .filter((t) => t.length > 0);
    if (paragraphs.length === 0) continue;
    if (phType === 'title' || phType === 'ctrTitle') {
      title = paragraphs.join(' ');
    } else {
      for (const line of paragraphs) {
        bullets.push(line.slice(0, 500));
        if (bullets.length >= 50) break;
      }
    }
    if (bullets.length >= 50) break;
  }
  return {
    index,
    title: title || rawName.slice(0, 200),
    bulletTexts: bullets.slice(0, 50),
    notes: '',
  };
}

function collectText(node: XmlNode): string {
  let out = node.text ?? '';
  for (const child of node.children) out += collectText(child);
  return out.trim().replace(/\s+/g, ' ');
}

function relMap(xml: string): Map<string, string> {
  const root = parseXml(xml);
  const out = new Map<string, string>();
  for (const rel of findAll(root, 'Relationship').slice(0, 200)) {
    const id = rel.attrs['Id'];
    const target = rel.attrs['Target'] ?? '';
    if (id && target) out.set(id, target);
  }
  return out;
}

function parseCore(xml: string): DocumentMetadataEntry[] {
  const out: DocumentMetadataEntry[] = [];
  try {
    const root = parseXml(xml);
    const push = (key: string): void => {
      const node = findFirst(root, key);
      const v = node?.text?.trim();
      if (typeof v === 'string' && v.length > 0)
        out.push({ key, value: v.slice(0, 500), source: 'document' });
    };
    push('dc:title');
    push('dc:creator');
  } catch {
    /* absent metadata is honest */
  }
  return out;
}

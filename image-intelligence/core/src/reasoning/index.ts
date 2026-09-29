/** Parsers that turn provider output into safe, bounded Veltravia structures.
 *
 *  Rules enforced here:
 *  - Provider output is text: only bare JSON objects are accepted, never
 *    markdown, never prose preambles.
 *  - Optional per-item data (boxes, confidence, ids) is kept only when it
 *    validates; otherwise it becomes an honest null - never a guess.
 *  - Region/element references coming back from a provider are untrusted;
 *    they survive only when they match manager-owned ids.
 *  - Arrays are capped with an explicit omission marker.
 *  - Result objects carry trust tags: untrusted_data (OCR) vs ai_generated
 *    (interpretation). */
import { ImageIntelligenceError } from '../errors/index.js';
import { elementId, nodeId, regionId, truncateText } from '../security/index.js';
import type {
  ChartAnalysis,
  ComparisonDifference,
  ComparisonResult,
  DiagramAnalysis,
  ExtractedField,
  FileAssetId,
  ImageDescription,
  ImageExtraction,
  ImageQueryResult,
  OcrRegion,
  OcrResult,
  ScreenshotAnalysis,
  ScreenshotIssue,
  ScreenshotIssueKind,
  UiElement,
  UiElementKind,
  UiStructure,
} from '../types/index.js';

const MAX_ITEMS = 200;
const MAX_STRING = 8000;
const OMIT = 'OTHER-DATA-OMITTED';

/** Accept ONLY a bare JSON object. No fences, no prose, no arrays. */
export function parseProviderJson(text: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}'))
    throw new ImageIntelligenceError(
      'IMAGE_PROVIDER_ERROR',
      'Provider output was not a bare JSON object.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Provider output was not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ImageIntelligenceError(
      'IMAGE_PROVIDER_ERROR',
      'Provider output was not a JSON object.',
    );
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, MAX_STRING));
}

function cappedList(value: readonly string[], max: number): readonly string[] {
  const out = value.slice(0, max);
  return value.length > max ? [...out, OMIT] : out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_STRING) : null;
}

/** Bounded list helper: keeps at most `max`, appends an omission marker item. */
function capItems<T>(items: readonly T[], max: number): readonly T[] {
  const out = items.slice(0, max);
  if (items.length > max) return [...out, { text: OMIT } as unknown as T];
  return out;
}

export function parseDescription(
  text: string,
  providerId: string,
  fileId: FileAssetId,
): ImageDescription {
  const raw = parseProviderJson(text);
  const summary = str(raw.summary);
  if (!summary)
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Description is missing a summary.');
  return {
    fileId,
    summary,
    observed: cappedList(stringArray(raw.observed), 50),
    inferences: cappedList(stringArray(raw.inferences), 50),
    providerId,
    trust: 'ai_generated',
  };
}

export function parseOcrResult(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  _frameId: string | null,
  now: string,
  maxCharacters: number,
): OcrResult {
  const raw = parseProviderJson(text);
  if (!Array.isArray(raw.regions))
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'OCR output is missing regions.');
  const candidates: {
    text: string;
    box: readonly [number, number, number, number] | null;
    confidence: number | null;
    readingOrder: number | null;
    index: number;
  }[] = [];
  raw.regions.forEach((value, index) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const regionText = typeof item.text === 'string' ? item.text.slice(0, MAX_STRING) : '';
    if (!regionText.trim()) return;
    let box: readonly [number, number, number, number] | null = null;
    if (
      Array.isArray(item.box) &&
      item.box.length === 4 &&
      item.box.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
    ) {
      const [x1, y1, x2, y2] = item.box as [number, number, number, number];
      if (x2 > x1 && y2 > y1) box = [x1, y1, x2, y2];
    }
    let confidence: number | null = null;
    if (
      typeof item.confidence === 'number' &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 0 &&
      item.confidence <= 1
    )
      confidence = item.confidence;
    let readingOrder: number | null = null;
    if (
      typeof item.readingOrder === 'number' &&
      Number.isInteger(item.readingOrder) &&
      item.readingOrder >= 0
    )
      readingOrder = item.readingOrder;
    candidates.push({ text: regionText, box, confidence, readingOrder, index });
  });
  const capped = capItems(candidates, MAX_ITEMS);
  const regions: OcrRegion[] = capped.map((c, i) => ({
    id: c.text === OMIT ? regionId(checksum, 99_999 + i) : regionId(checksum, c.index),
    text: c.text,
    box: c.box,
    confidence: c.confidence,
    readingOrder: c.readingOrder,
  }));
  const ordered = [...regions].sort(
    (a, b) =>
      (a.readingOrder ?? Number.MAX_SAFE_INTEGER) - (b.readingOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const joined = ordered.map((r) => r.text).join('\n');
  const bounded = truncateText(joined, maxCharacters);
  return {
    fileId,
    regions,
    text: bounded.text,
    regionsAvailable: regions.some((r) => r.box !== null),
    confidenceAvailable: regions.some((r) => r.confidence !== null),
    providerId,
    createdAt: now,
    trust: 'untrusted_data',
  };
}

export function parseQueryResult(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  question: string,
): ImageQueryResult {
  const raw = parseProviderJson(text);
  const answer = str(raw.answer);
  if (!answer)
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Query output is missing an answer.');
  const insufficient =
    typeof raw.insufficientEvidence === 'boolean' ? raw.insufficientEvidence : false;
  return {
    fileId,
    question,
    answer,
    insufficientEvidence: insufficient,
    providerId,
    trust: 'ai_generated',
  };
}

const ISSUE_KINDS: readonly ScreenshotIssueKind[] = [
  'overlap',
  'clipping',
  'spacing',
  'alignment',
  'readability',
  'contrast',
  'hierarchy',
  'missing_element',
  'duplicated_control',
  'suspicious_state',
  'other',
];

function basis(value: unknown): 'fact' | 'inference' {
  return value === 'inference' ? 'inference' : 'fact';
}

export function parseScreenshotAnalysis(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  realRegionIds: ReadonlySet<string>,
): ScreenshotAnalysis {
  const raw = parseProviderJson(text);
  if (!Array.isArray(raw.issues))
    throw new ImageIntelligenceError(
      'IMAGE_PROVIDER_ERROR',
      'Screenshot analysis is missing issues.',
    );
  const issues: ScreenshotIssue[] = raw.issues
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item, index) => {
      const rawKind = typeof item.kind === 'string' ? (item.kind as ScreenshotIssueKind) : 'other';
      const kind = ISSUE_KINDS.includes(rawKind) ? rawKind : 'other';
      const statement =
        typeof item.statement === 'string'
          ? item.statement.slice(0, MAX_STRING)
          : 'Unstated observation.';
      const claimed = typeof item.regionId === 'string' ? item.regionId : null;
      return {
        id: elementId(`issue:${String(fileId)}`, index),
        kind,
        statement,
        basis: basis(item.basis),
        // Provider-claimed region references survive only if manager-owned.
        regionId: claimed !== null && realRegionIds.has(claimed) ? claimed : null,
      };
    })
    .slice(0, MAX_ITEMS);
  return { fileId, issues, providerId, trust: 'ai_generated' };
}

const ELEMENT_KINDS: readonly UiElementKind[] = [
  'navigation',
  'header',
  'sidebar',
  'card',
  'button',
  'input',
  'tab',
  'table',
  'dialog',
  'image',
  'icon',
  'text',
  'list',
  'chart',
  'unknown',
];

export function parseUiStructure(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
  realRegionIds: ReadonlySet<string>,
): UiStructure {
  const raw = parseProviderJson(text);
  if (!Array.isArray(raw.elements))
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'UI structure is missing elements.');
  const elements: UiElement[] = raw.elements
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item, index) => {
      const rawKind = typeof item.kind === 'string' ? (item.kind as UiElementKind) : 'unknown';
      const kind = ELEMENT_KINDS.includes(rawKind) ? rawKind : 'unknown';
      const label = str(item.label);
      const claimed = typeof item.regionId === 'string' ? item.regionId : null;
      return {
        id: elementId(checksum, index),
        kind,
        label,
        regionId: claimed !== null && realRegionIds.has(claimed) ? claimed : null,
      };
    })
    .slice(0, MAX_ITEMS);
  return {
    fileId,
    elements,
    notes: [
      'This structure is inferred from pixels. It is a visual interpretation, not the original DOM.',
      'Element kinds are AI guesses with the confidence the provider declares; they are not source code.',
    ],
    providerId,
    trust: 'ai_generated',
  };
}

export function parseChartAnalysis(
  text: string,
  providerId: string,
  fileId: FileAssetId,
): ChartAnalysis {
  const raw = parseProviderJson(text);
  const chartType = str(raw.chartType) ?? 'unknown';
  const title = str(raw.title);
  return {
    fileId,
    chartType,
    title,
    observed: cappedList(stringArray(raw.observed), 50),
    inferences: cappedList(stringArray(raw.inferences), 50),
    // Only provider-read value labels are kept, as strings - never invented.
    values: stringArray(raw.values).slice(0, 50),
    providerId,
    trust: 'ai_generated',
  };
}

export function parseDiagramAnalysis(
  text: string,
  providerId: string,
  fileId: FileAssetId,
  checksum: string,
): DiagramAnalysis {
  const raw = parseProviderJson(text);
  if (!Array.isArray(raw.nodes))
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Diagram output is missing nodes.');
  const nodes = raw.nodes
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item, index) => ({
      id: nodeId(checksum, index),
      label: str(item.label) ?? 'Unknown',
      kind: str(item.kind) ?? 'unknown',
    }))
    .slice(0, MAX_ITEMS);
  const byIndex = new Map(nodes.map((n, i) => [i, n]));
  const relationships = (Array.isArray(raw.relationships) ? raw.relationships : [])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item, index) => {
      const from = typeof item.fromIndex === 'number' ? item.fromIndex : Number.NaN;
      const to = typeof item.toIndex === 'number' ? item.toIndex : Number.NaN;
      const fromNode = Number.isInteger(from) ? byIndex.get(from) : undefined;
      const toNode = Number.isInteger(to) ? byIndex.get(to) : undefined;
      if (!fromNode || !toNode) return null; // forged edges never survive
      return {
        id: nodeId(`${checksum}:rel`, index),
        fromId: fromNode.id,
        toId: toNode.id,
        label: str(item.label) ?? 'unlabeled',
        kind: str(item.kind) ?? 'unknown',
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, MAX_ITEMS);
  return { fileId, nodes, relationships, providerId, trust: 'ai_generated' };
}

export function parseComparisonResult(
  text: string,
  providerId: string,
  fileAId: FileAssetId,
  fileBId: FileAssetId,
): ComparisonResult {
  const raw = parseProviderJson(text);
  const summary = str(raw.summary);
  if (!summary)
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Comparison is missing a summary.');
  const kinds: readonly ComparisonDifference['kind'][] = [
    'text_change',
    'element_added',
    'element_removed',
    'layout_change',
    'color_change',
    'chart_change',
    'screenshot_change',
    'other',
  ];
  const differences: ComparisonDifference[] = (
    Array.isArray(raw.differences) ? raw.differences : []
  )
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item) => {
      const k = str(item.kind);
      return {
        kind: kinds.includes(k as ComparisonDifference['kind'])
          ? (k as ComparisonDifference['kind'])
          : 'other',
        statement: str(item.statement) ?? 'Unstated difference.',
        basis: basis(item.basis),
      };
    })
    .slice(0, MAX_ITEMS);
  return { fileAId, fileBId, summary, differences, providerId, trust: 'ai_generated' };
}

export function parseExtraction(
  text: string,
  providerId: string,
  fileId: FileAssetId,
): ImageExtraction {
  const raw = parseProviderJson(text);
  if (!Array.isArray(raw.fields))
    throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'Extraction is missing fields.');
  const fields: ExtractedField[] = raw.fields
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((item) => ({
      field: str(item.field) ?? '',
      value: str(item.value) ?? '',
      uncertain: item.uncertain === true,
    }))
    .filter((f) => f.field.trim().length > 0)
    .slice(0, 50);
  return { fileId, fields, providerId, trust: 'ai_generated' };
}

/**
 * DocumentIntelligenceManager - bounded, auditable document understanding on
 * top of the Step 19 File Intelligence system.
 *
 * Security invariants:
 * - Document content is UNTRUSTED DATA. Extracted text, tables, cells and
 *   OCR output are untrusted data. Reasoning output is ai_generated.
 *   Nothing here executes scripts, macros, formulas or actions found inside
 *   a document; visible text never becomes authorization.
 * - Every read re-authorizes through FileIntelligenceManager (scope, expiry,
 *   integrity) - the document layer adds no second trust path.
 * - Formats are detected from magic bytes, never from declared MIME types.
 * - Reasoning operations require a processed record and re-validate the
 *   caller per call. Evidence quotes are verified against the parsed
 *   structure; forged quotes and references are dropped.
 * - All processing is bounded: bytes, elements, tables, rows, slides,
 *   concurrent jobs, wall-clock time.
 * - Cancellation is one-way and audited; jobs expire.
 * - Audit metadata never contains document content.
 */
import {
  type FileAssetId,
  type FileIntelligenceManager,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';
import {
  DocumentIntelligenceError,
  isDocumentIntelligenceError,
  mapFileError,
} from '../errors/index.js';
import { resolveDocumentLimits } from '../limits/index.js';
import type { DocumentAuditSink } from '../audit/index.js';
import { assertNoSecretShape, newJobId } from '../security/index.js';
import {
  inspectDocumentFormat,
  parseDocument,
  type DocumentParseLimits,
} from '../formats/index.js';
import { parsePptx } from '../formats/pptx.js';
import { parseXlsx } from '../formats/xlsx.js';
import { readZipParts, zipEntryPaths } from '../formats/zipreader.js';
import { DocumentProviderRegistry, type DocumentProvider } from '../provider/index.js';
import {
  parseAnswer,
  parseComparison,
  parseEntities,
  parseProviderJson,
  parseSemanticSearch,
  parseSummary,
  type ReasoningLimits,
} from '../reasoning/index.js';
import {
  DOCUMENT_CAPABILITIES,
  type DocumentAnswerView,
  type DocumentArtifactInput,
  type DocumentArtifactView,
  type DocumentComparisonView,
  type DocumentEntitiesView,
  type DocumentExactSearchResult,
  type DocumentInspectionView,
  type DocumentLimits,
  type DocumentMemoryCandidate,
  type DocumentProcessingJob,
  type DocumentSearchMatch,
  type DocumentStructureView,
  type DocumentSummaryMode,
  type DocumentSummaryView,
  type DocumentJobError,
  type DocumentJobStatus,
} from '../types/index.js';

export interface DocumentIntelligenceOptions {
  /** Step 19 manager: bytes, metadata, scope authorization. */
  readonly files: FileIntelligenceManager;
  /** Registry of configured providers (mock or real adapters). */
  readonly providers: DocumentProviderRegistry;
  readonly limits?: Partial<DocumentLimits>;
  readonly now?: () => Date;
  /** Optional audit sink; events are scrubbed metadata only. */
  readonly audit?: DocumentAuditSink;
}

interface JobRecord {
  job: DocumentProcessingJob;
  cancelled: boolean;
  /** Owner the job was started for; job reads are scoped to that owner. */
  ownerRef: string;
}

interface StructureRecord {
  structure: DocumentStructureView;
  processedAt: string;
  jobId: string | null;
}

const TERMINAL: readonly DocumentJobStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
const TRANSITIONS: Record<DocumentJobStatus, readonly DocumentJobStatus[]> = {
  received: ['parsing', 'cancelled'],
  parsing: ['parsed', 'failed', 'cancelled'],
  parsed: ['reasoning', 'cancelled'],
  reasoning: ['completed', 'failed', 'cancelled'],
  completed: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
};

export class DocumentIntelligenceManager {
  readonly limits: DocumentLimits;
  private readonly files: FileIntelligenceManager;
  private readonly providers: DocumentProviderRegistry;
  private readonly now: () => Date;
  private readonly sink?: DocumentAuditSink;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly structures = new Map<string, StructureRecord>();
  private activeProviderCalls = 0;

  constructor(options: DocumentIntelligenceOptions) {
    this.files = options.files;
    this.providers = options.providers;
    this.limits = resolveDocumentLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.sink = options.audit;
  }

  /** True when the active provider is a deterministic simulation. */
  get providerIsSimulation(): boolean {
    return this.providers.list().length > 0
      ? this.providers.list().every((p) => p.getCapabilities().simulated)
      : false;
  }

  /** Every capability the configured providers declare. */
  capabilities(): readonly string[] {
    const out = new Set<string>();
    for (const provider of this.providers.list())
      for (const capability of provider.getCapabilities().capabilities) out.add(capability);
    return [...out].sort();
  }

  /** Magic-byte format inspection without processing. */
  async inspect(fileId: FileAssetId, principal: FilePrincipal): Promise<DocumentInspectionView> {
    this.expireJobs();
    const { bytes, asset } = await this.requireDocument(fileId, principal);
    if (bytes.byteLength > this.limits.maxFileBytes)
      throw new DocumentIntelligenceError('DOCUMENT_LIMIT_EXCEEDED', 'Document is too large.');
    const detected = inspectDocumentFormat(bytes);
    const simulated = this.providers.list().some((p) => p.getCapabilities().simulated);
    return {
      fileId: asset.id,
      format: detected.format,
      detectedFrom: 'magic-bytes',
      byteSize: bytes.byteLength,
      capabilities: [...DOCUMENT_CAPABILITIES],
      simulated,
    };
  }

  /** Process a document: deterministic genuine parsing into a bounded
   *  structural view, stored as a record for later reasoning. */
  async process(fileId: FileAssetId, principal: FilePrincipal): Promise<DocumentProcessingJob> {
    this.expireJobs();
    const { asset } = await this.requireDocument(fileId, principal);
    const jobId = newJobId();
    const job: DocumentProcessingJob = {
      jobId,
      fileId: asset.id,
      status: 'received',
      error: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
    };
    const record: JobRecord = { job, cancelled: false, ownerRef: principal.ownerRef };
    this.jobs.set(jobId, record);
    this.audit('document_processing_started', principal.ownerRef, {
      jobId,
      fileId,
    });
    try {
      this.transition(record, 'parsing');
      const { bytes } = await this.requireDocument(fileId, principal);
      if (bytes.byteLength > this.limits.maxFileBytes)
        throw new DocumentIntelligenceError('DOCUMENT_LIMIT_EXCEEDED', 'Document is too large.');
      const detected = inspectDocumentFormat(bytes);
      if (detected.format === 'unknown')
        throw new DocumentIntelligenceError(
          'DOCUMENT_UNSUPPORTED_FORMAT',
          'Document format is not supported.',
        );
      const parseLimits: DocumentParseLimits = {
        maxFileBytes: this.limits.maxFileBytes,
        maxElements: this.limits.maxElements,
        maxSections: this.limits.maxSections,
        maxTables: this.limits.maxTables,
        maxTableRows: this.limits.maxTableRows,
        maxSheetRows: this.limits.maxSheetRows,
        maxSlides: this.limits.maxSlides,
      };
      const structure = parseDocument(detected.format, bytes, fileId, parseLimits);
      // Fail closed: secret-shaped content inside the document is rejected,
      // never stored and never sent to any provider.
      const joined = structure.elements
        .map((e) => e.text)
        .join('\n')
        .slice(0, 100000);
      assertNoSecretShape(joined, 'document text');
      this.transition(record, 'parsed');
      if (record.cancelled) throw cancelError();
      this.transition(record, 'reasoning');
      // The provider is offered the parsed structure so it can validate its
      // readiness; the structural view itself is deterministic local output.
      const provider = this.providers.findForCapability('document_understanding');
      if (provider) await this.callProvider(provider, 'process', structure, {});
      this.structures.set(fileId, {
        structure,
        processedAt: this.now().toISOString(),
        jobId,
      });
      this.transition(record, 'completed');
      this.audit('document_processing_completed', principal.ownerRef, {
        jobId,
        fileId,
        format: structure.format,
        elementCount: structure.elements.length,
      });
      return { ...record.job };
    } catch (error) {
      const failed = jobError(error);
      record.job = {
        ...record.job,
        status: 'failed',
        error: failed,
        finishedAt: this.now().toISOString(),
      };
      this.audit('document_processing_failed', principal.ownerRef, {
        jobId,
        fileId,
        error: failed.code,
      });
      return { ...record.job };
    }
  }

  /** Job reads are owner-scoped: a foreign job id is indistinguishable from
   *  an unknown one, so job existence never leaks across owners. */
  private requireOwnedJob(jobId: string, principal: FilePrincipal): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record || record.ownerRef !== principal.ownerRef)
      throw new DocumentIntelligenceError('DOCUMENT_JOB_NOT_FOUND', 'Unknown document job.');
    return record;
  }

  async getJob(jobId: string, principal: FilePrincipal): Promise<DocumentProcessingJob> {
    this.expireJobs();
    return { ...this.requireOwnedJob(jobId, principal).job };
  }

  /** Bounded, newest-first job list for one owner. */
  async listJobs(principal: FilePrincipal): Promise<readonly DocumentProcessingJob[]> {
    this.expireJobs();
    return [...this.jobs.values()]
      .filter((record) => record.ownerRef === principal.ownerRef)
      .map((record) => record.job)
      .reverse()
      .slice(0, 100);
  }

  /** One-way cancellation; a cancelled job never resumes. */
  async cancelJob(jobId: string, principal: FilePrincipal): Promise<DocumentProcessingJob> {
    this.expireJobs();
    const record = this.requireOwnedJob(jobId, principal);
    if (TERMINAL.includes(record.job.status)) return { ...record.job };
    record.cancelled = true;
    if (record.job.status === 'received' || record.job.status === 'parsing') {
      record.job = { ...record.job, status: 'cancelled', finishedAt: this.now().toISOString() };
    }
    this.audit('document_job_cancelled', 'system', { jobId });
    return { ...record.job };
  }

  /** The deterministic structural view. Requires processing first. */
  async getStructure(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<DocumentStructureView> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    return record.structure;
  }

  /** Deterministic exact-text search over the parsed structure. */
  async searchExact(
    fileId: FileAssetId,
    query: string,
    principal: FilePrincipal,
  ): Promise<DocumentExactSearchResult> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const normalized = query.trim();
    if (!normalized)
      throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Query is required.');
    const needle = normalized.toLowerCase();
    const matches: DocumentSearchMatch[] = [];
    let total = 0;
    for (const element of record.structure.elements) {
      const idx = element.text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      total += 1;
      if (matches.length < this.limits.maxSearchMatches) {
        matches.push({
          elementId: element.id,
          snippet: element.text.slice(0, 600),
          score: 1,
        });
      }
    }
    return {
      fileId,
      matches,
      total,
      truncated: total > matches.length,
      trustTag: 'untrusted_data',
    };
  }

  async ask(
    fileId: FileAssetId,
    question: string,
    principal: FilePrincipal,
  ): Promise<DocumentAnswerView> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const q = question.trim();
    if (!q)
      throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Question is required.');
    const provider = this.requireProvider('question_answering');
    const raw = await this.callProvider(provider, 'answer', record.structure, {
      question: q,
    });
    return parseAnswer(record.structure, q, parseProviderJson(raw), this.reasoningLimits());
  }

  async summarize(
    fileId: FileAssetId,
    mode: DocumentSummaryMode,
    principal: FilePrincipal,
  ): Promise<DocumentSummaryView> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const provider = this.requireProvider('summarization');
    const raw = await this.callProvider(provider, 'summarize', record.structure, { mode });
    return parseSummary(record.structure, mode, parseProviderJson(raw), this.reasoningLimits());
  }

  async extractEntities(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<DocumentEntitiesView> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const provider = this.requireProvider('entity_extraction');
    const raw = await this.callProvider(provider, 'entities', record.structure, {});
    return parseEntities(record.structure, parseProviderJson(raw), this.reasoningLimits());
  }

  async semanticSearch(
    fileId: FileAssetId,
    query: string,
    principal: FilePrincipal,
  ): Promise<{
    fileId: FileAssetId;
    matches: readonly DocumentSearchMatch[];
    total: number;
    truncated: boolean;
    trustTag: 'ai_generated';
  }> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const q = query.trim();
    if (!q) throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Query is required.');
    const provider = this.requireProvider('semantic_search');
    const raw = await this.callProvider(provider, 'semantic-search', record.structure, {
      query: q,
    });
    const matches = parseSemanticSearch(
      record.structure,
      parseProviderJson(raw),
      this.reasoningLimits(),
    );
    return {
      fileId,
      matches,
      total: matches.length,
      truncated: false,
      trustTag: 'ai_generated',
    };
  }

  async compare(
    leftFileId: FileAssetId,
    rightFileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<DocumentComparisonView> {
    this.expireJobs();
    const left = await this.requireProcessed(leftFileId, principal);
    const right = await this.requireProcessed(rightFileId, principal);
    if (leftFileId === rightFileId)
      throw new DocumentIntelligenceError(
        'DOCUMENT_INVALID_REQUEST',
        'A document cannot be compared with itself.',
      );
    const provider = this.requireProvider('comparison_reasoning');
    const raw = await this.callProvider(provider, 'compare', left.structure, {}, right.structure);
    return parseComparison(
      left.structure,
      right.structure,
      parseProviderJson(raw),
      this.reasoningLimits(),
    );
  }

  /** Provider-mediated OCR. Honest providers refuse formats they cannot read. */
  async ocr(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{
    fileId: FileAssetId;
    text: string;
    truncated: boolean;
    trustTag: 'untrusted_data';
  }> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const provider = this.requireProvider('ocr');
    const raw = await this.callProvider(provider, 'ocr', record.structure, {});
    const parsed = parseProviderJson(raw);
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!text)
      throw new DocumentIntelligenceError(
        'DOCUMENT_PROVIDER_ERROR',
        'Provider returned no OCR text.',
      );
    const capped = text.slice(0, this.limits.maxOcrChars);
    return {
      fileId,
      text: capped,
      truncated: text.length > this.limits.maxOcrChars,
      trustTag: 'untrusted_data',
    };
  }

  /** Deterministic spreadsheet view for xlsx/csv documents. */
  async spreadsheetView(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{
    fileId: FileAssetId;
    sheets: readonly {
      name: string;
      rowCount: number;
      columnCount: number;
      headers: readonly string[];
      rows: readonly (readonly string[])[];
      formulaCells: number;
      stats: readonly {
        header: string;
        numericCount: number;
        numericRatio: number | null;
        min: number | null;
        max: number | null;
        sum: number | null;
        mean: number | null;
      }[];
    }[];
    truncated: boolean;
    trustTag: 'untrusted_data';
  }> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const format = record.structure.format;
    if (format !== 'xlsx' && format !== 'csv')
      throw new DocumentIntelligenceError(
        'DOCUMENT_UNSUPPORTED_FORMAT',
        'Spreadsheet view requires a spreadsheet document.',
      );
    if (format === 'csv') {
      const table = record.structure.tables[0];
      const rows = table ? table.rows.length : 0;
      const headers = table ? table.headers : [];
      return {
        fileId,
        sheets: [
          {
            name: 'CSV',
            rowCount: rows,
            columnCount: headers.length,
            headers,
            rows: table ? table.rows : [],
            formulaCells: 0,
            stats: [],
          },
        ],
        truncated: table?.truncated ?? false,
        trustTag: 'untrusted_data',
      };
    }
    const { bytes } = await this.requireDocument(fileId, principal);
    const paths = zipEntryPaths(bytes);
    const wanted = paths
      .filter((p) => p.startsWith('xl/') || p.startsWith('docProps/'))
      .slice(0, 200);
    const parts = readZipParts(bytes, wanted, 40 * 1024 * 1024);
    const result = parseXlsx(parts, {
      maxSheetRows: this.limits.maxSheetRows,
      maxElements: this.limits.maxTables,
    });
    return {
      fileId,
      sheets: result.sheets,
      truncated: result.truncated,
      trustTag: 'untrusted_data',
    };
  }

  /** Deterministic presentation view for pptx documents. */
  async presentationView(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{
    fileId: FileAssetId;
    slides: readonly {
      index: number;
      title: string;
      bulletTexts: readonly string[];
      notes: string;
    }[];
    truncated: boolean;
    trustTag: 'untrusted_data';
  }> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    if (record.structure.format !== 'pptx')
      throw new DocumentIntelligenceError(
        'DOCUMENT_INVALID_REQUEST',
        'Presentation view requires a presentation document.',
      );
    const { bytes } = await this.requireDocument(fileId, principal);
    const paths = zipEntryPaths(bytes);
    const wanted = paths
      .filter((p) => p.startsWith('ppt/') || p.startsWith('docProps/'))
      .slice(0, 200);
    const parts = readZipParts(bytes, wanted, 40 * 1024 * 1024);
    const result = parsePptx(parts, { maxSlides: this.limits.maxSlides }, fileId);
    return {
      fileId,
      slides: result.slides,
      truncated: result.truncated,
      trustTag: 'untrusted_data',
    };
  }

  /** Non-authoritative memory candidates derived from the structure. */
  async memoryCandidates(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<readonly DocumentMemoryCandidate[]> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const structure = record.structure;
    const title =
      structure.metadata.find((m) => m.key === 'dc:title' || m.key === 'Title')?.value ??
      'Document summary';
    const headings = structure.elements.filter((e) => e.type === 'heading' && e.text).slice(0, 5);
    const candidates: DocumentMemoryCandidate[] = [];
    candidates.push({
      title: truncate(`${title} - overview`, 200),
      content: truncate(
        [
          `Format: ${structure.format}.`,
          `Elements: ${structure.elements.length}.`,
          headings.length > 0
            ? `Main sections: ${headings
                .map((h) => h.text)
                .join('; ')
                .slice(0, 400)}`
            : 'No headings detected.',
        ].join(' '),
        2000,
      ),
      source: 'system_derived',
      sourceKind: 'document_analysis',
      elementIds: headings.map((h) => h.id),
    });
    const stats = structure.metadata
      .filter((m) => m.key === 'dc:creator' || m.key === 'Author')
      .slice(0, 1);
    if (stats.length > 0)
      candidates.push({
        title: truncate(`${title} - author`, 200),
        content: `Document author metadata: ${stats[0]?.value ?? ''}`.slice(0, 500),
        source: 'system_derived',
        sourceKind: 'document_analysis',
        elementIds: [],
      });
    return candidates;
  }

  // ---------------------------------------------------------------- internals

  private reasoningLimits(): ReasoningLimits {
    return {
      maxAnswerChars: this.limits.maxAnswerChars,
      maxEvidenceQuotes: this.limits.maxEvidenceQuotes,
      maxEntities: this.limits.maxEntities,
      maxSearchMatches: this.limits.maxSearchMatches,
    };
  }

  private async requireProcessed(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<StructureRecord> {
    // Re-authorize BEFORE consulting any cached state: an unauthorized
    // caller must never learn whether a document was processed.
    await this.requireDocument(fileId, principal);
    const record = this.structures.get(fileId);
    if (!record)
      throw new DocumentIntelligenceError(
        'DOCUMENT_NOT_PROCESSED',
        'Process the document before reasoning about it.',
      );
    return record;
  }

  private async requireDocument(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{ bytes: Uint8Array; asset: { id: FileAssetId } }> {
    try {
      const fetched = await this.files.documentBytes(fileId, principal);
      const asset = await this.files.getFile(fileId, principal);
      return { bytes: fetched.bytes, asset: { id: asset.id } };
    } catch (error) {
      if (isDocumentIntelligenceError(error)) throw error;
      throw mapFileError(error);
    }
  }

  private requireProvider(capability: (typeof DOCUMENT_CAPABILITIES)[number]): DocumentProvider {
    const provider = this.providers.findForCapability(capability);
    if (!provider)
      throw new DocumentIntelligenceError(
        'DOCUMENT_PROVIDER_ERROR',
        `No provider is configured for ${capability}.`,
      );
    return provider;
  }

  private async callProvider(
    provider: DocumentProvider,
    operation: Parameters<DocumentProvider['process']>[0]['operation'],
    structure: DocumentStructureView,
    input: Readonly<Record<string, unknown>>,
    compareStructure?: DocumentStructureView,
  ): Promise<string> {
    if (this.activeProviderCalls >= this.limits.maxConcurrentProviderCalls)
      throw new DocumentIntelligenceError(
        'DOCUMENT_LIMIT_EXCEEDED',
        'Too many concurrent provider calls.',
      );
    this.activeProviderCalls += 1;
    const started = Date.now();
    try {
      const result = await provider.process({ operation, structure, input, compareStructure });
      if (Date.now() - started > this.limits.maxProcessingMs)
        throw new DocumentIntelligenceError(
          'DOCUMENT_LIMIT_EXCEEDED',
          'Provider call exceeded the time ceiling.',
        );
      return result;
    } catch (error) {
      if (isDocumentIntelligenceError(error)) throw error;
      throw new DocumentIntelligenceError(
        'DOCUMENT_PROVIDER_ERROR',
        'The document provider failed.',
      );
    } finally {
      this.activeProviderCalls -= 1;
    }
  }

  private transition(record: JobRecord, next: DocumentJobStatus): void {
    const allowed = TRANSITIONS[record.job.status];
    if (!allowed.includes(next))
      throw new DocumentIntelligenceError(
        'DOCUMENT_INVALID_REQUEST',
        `Cannot move job from ${record.job.status} to ${next}.`,
      );
    record.job = { ...record.job, status: next };
    if (next === 'completed' || next === 'failed' || next === 'cancelled')
      record.job = { ...record.job, finishedAt: this.now().toISOString() };
  }

  private expireJobs(): void {
    const horizon = this.now().getTime() - this.limits.jobExpiryMs;
    for (const record of this.jobs.values()) {
      if (TERMINAL.includes(record.job.status) && record.job.status !== 'expired') {
        const finished = Date.parse(record.job.finishedAt ?? record.job.startedAt);
        if (Number.isFinite(finished) && finished < horizon) {
          record.job = { ...record.job, status: 'expired' };
        }
      }
    }
  }

  /** Publish a derived export through the Step 19 file system. Every byte is
   *  regenerated from the current structure, so an artifact can never carry
   *  stale or unverified content. */
  async saveArtifact(
    fileId: FileAssetId,
    principal: FilePrincipal,
    draft: DocumentArtifactInput,
  ): Promise<DocumentArtifactView> {
    this.expireJobs();
    const record = await this.requireProcessed(fileId, principal);
    const asset = await this.files.getFile(fileId, principal);
    const base = asset.metadata.normalizedFilename.replace(/\.[^.]+$/, '').slice(0, 120);
    const needs = (present: boolean, message: string): void => {
      if (!present) throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', message);
    };
    const buffer = (text: string): Buffer => Buffer.from(text, 'utf8');
    const structure = record.structure;
    let filename: string;
    let mimeType: string;
    let bytes: Buffer;
    switch (draft.kind) {
      case 'document_structure_json':
        filename = `${base}-structure.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(structure, null, 2));
        break;
      case 'document_text_md': {
        const lines = structure.elements.map((e) =>
          e.type === 'heading'
            ? `${'#'.repeat(Math.min(Math.max(e.level ?? 1, 1), 6))} ${e.text}`
            : e.type === 'listItem'
              ? `- ${e.text}`
              : e.text,
        );
        filename = `${base}-text.md`;
        mimeType = 'text/markdown';
        bytes = buffer(lines.join('\n\n'));
        break;
      }
      case 'document_tables_csv': {
        const escape = (cell: string): string => `"${cell.replace(/"/g, '""')}"`;
        const csvOf = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
          [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n');
        const chunks: string[] = structure.tables.map((table) => csvOf(table.headers, table.rows));
        // Spreadsheets keep their cells in the workbook, not in structural
        // tables, so rebuild their CSV from the bounded sheet rows.
        if (chunks.length === 0 && (structure.format === 'xlsx' || structure.format === 'csv')) {
          const view = await this.spreadsheetView(fileId, principal);
          for (const sheet of view.sheets)
            chunks.push(`# ${sheet.name}\n${csvOf(sheet.headers, sheet.rows)}`);
        }
        needs(chunks.length > 0, 'This document has no tables to export.');
        filename = `${base}-tables.csv`;
        mimeType = 'text/csv';
        bytes = buffer(chunks.join('\n\n'));
        break;
      }
      case 'document_summary_md': {
        const summary = await this.summarize(fileId, draft.mode ?? 'brief', principal);
        filename = `${base}-summary.md`;
        mimeType = 'text/markdown';
        bytes = buffer(`# Summary\n\n${summary.summary}\n`);
        break;
      }
      case 'document_entities_json': {
        const entities = await this.extractEntities(fileId, principal);
        filename = `${base}-entities.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(entities, null, 2));
        break;
      }
      case 'document_search_json': {
        const query = (draft.query ?? '').trim();
        needs(query.length > 0, 'A search query is required for a search export.');
        const result = await this.searchExact(fileId, query, principal);
        filename = `${base}-search.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(result, null, 2));
        break;
      }
      case 'document_comparison_json': {
        const other = draft.otherFileId ?? null;
        needs(!!other, 'A second document is required for a comparison export.');
        const comparison = await this.compare(fileId, other as FileAssetId, principal);
        filename = `${base}-comparison.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(comparison, null, 2));
        break;
      }
      default:
        throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Unknown artifact kind.');
    }
    const saved = await this.files.registerFile({
      filename,
      bytes,
      declaredMimeType: mimeType,
      source: 'derived_extraction',
      scope: asset.scope,
      parentFileId: fileId,
    });
    this.audit('document_artifact_saved', principal.ownerRef, {
      fileId: String(fileId),
      kind: draft.kind,
      filename: saved.metadata.normalizedFilename,
    });
    return {
      id: saved.id,
      kind: draft.kind,
      filename: saved.metadata.normalizedFilename,
      mimeType: saved.metadata.detectedMimeType ?? mimeType,
      byteSize: saved.metadata.byteSize,
      createdAt: saved.createdAt,
      projectId: saved.scope.projectId,
      workspaceId: saved.scope.workspaceId,
    };
  }

  private audit(
    type: string,
    ownerRef: string,
    fields: Record<string, string | number | null>,
  ): void {
    if (!this.sink) return;
    this.sink.record({ type, ownerRef, ...fields });
  }
}

function cancelError(): DocumentIntelligenceError {
  return new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Job was cancelled.');
}

function jobError(error: unknown): DocumentJobError {
  if (isDocumentIntelligenceError(error)) return { code: error.code, message: error.message };
  // Unexpected failures never echo raw internals to callers.
  return { code: 'DOCUMENT_FILE_ERROR', message: 'The document could not be processed.' };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

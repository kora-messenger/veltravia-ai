/**
 * ImageIntelligenceManager - bounded, auditable image and screenshot
 * understanding on top of the Step 19 File Intelligence system.
 *
 * Security invariants:
 * - Image content is UNTRUSTED DATA. OCR text is untrusted data. Reasoning
 *   output is ai_generated. Nothing here executes tools, mutates projects,
 *   or treats visible text as authorization.
 * - Every read re-authorizes through FileIntelligenceManager (scope, expiry,
 *   integrity) - the image layer adds no second trust path.
 * - Formats are detected from magic bytes, never from declared MIME types;
 *   script-bearing SVG never reaches a provider.
 * - All processing is bounded: bytes, dimensions, frames, concurrent jobs,
 *   wall-clock time, OCR size.
 * - Provider-claimed region ids are untrusted: they survive only when they
 *   match manager-owned ids.
 * - Cancellation is one-way and audited; jobs expire.
 * - Audit metadata never contains image content or OCR text.
 */
import {
  FileIntelligenceError,
  isFileIntelligenceError,
  type FileAsset,
  type FileAssetId,
  type FileIntelligenceManager,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';
import { ImageIntelligenceError } from '../errors/index.js';
import { resolveImageLimits } from '../limits/index.js';
import type { ImageAuditSink } from '../audit/index.js';
import {
  detectImageFormat,
  formatFromMime,
  newImageJobId,
  parseAnimationInfo,
  parsePngInfo,
  pngDimensions,
  svgHasScript,
  withinDimensionCeiling,
} from '../security/index.js';
import {
  parseChartAnalysis,
  parseComparisonResult,
  parseDescription,
  parseDiagramAnalysis,
  parseExtraction,
  parseOcrResult,
  parseProviderJson,
  parseQueryResult,
  parseScreenshotAnalysis,
  parseUiStructure,
} from '../reasoning/index.js';
import { ImageProviderRegistry } from '../provider/index.js';
import {
  IMAGE_PROVIDER_OPERATIONS,
  type AIImageAttachment,
  type ChartAnalysis,
  type ComparisonResult,
  type DiagramAnalysis,
  type ImageAnalysisRecord,
  type ImageArtifactKind,
  type ImageArtifactView,
  type ImageDescription,
  type ImageExtraction,
  type ImageFormat,
  type ImageLimits,
  type ImageMetadata,
  type ImageProcessingJob,
  type ImageProcessingStatus,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ImageProviderRequest,
  type ImageQueryResult,
  type ImageSearchMatch,
  type ImageSearchResult,
  type OcrResult,
  type ScreenshotAnalysis,
  type UiStructure,
} from '../types/index.js';

export interface ImageIntelligenceOptions {
  /** Step 19 manager: bytes, metadata, scope authorization. */
  readonly files: FileIntelligenceManager;
  /** Registry of configured providers (mock or real adapters). */
  readonly providers: ImageProviderRegistry;
  readonly limits?: Partial<ImageLimits>;
  readonly now?: () => Date;
  /** Optional audit sink; events are scrubbed metadata only. */
  readonly audit?: ImageAuditSink;
}

interface JobRecord {
  job: ImageProcessingJob;
  cancelled: boolean;
}

interface AnalysisRecord {
  description: ImageDescription | null;
  ocr: OcrResult | null;
  screenshot: ScreenshotAnalysis | null;
  uiStructure: UiStructure | null;
  chart: ChartAnalysis | null;
  diagram: DiagramAnalysis | null;
  extraction: ImageExtraction | null;
  comparison: ComparisonResult | null;
  jobId: string | null;
}

const TERMINAL: readonly ImageProcessingStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
const TRANSITIONS: Record<ImageProcessingStatus, readonly ImageProcessingStatus[]> = {
  received: ['validating', 'cancelled'],
  validating: ['validated', 'failed', 'cancelled'],
  validated: ['processing', 'cancelled'],
  processing: ['analyzing', 'failed', 'cancelled'],
  analyzing: ['completed', 'failed', 'cancelled'],
  completed: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
};

function emptyRecord(): AnalysisRecord {
  return {
    description: null,
    ocr: null,
    screenshot: null,
    uiStructure: null,
    chart: null,
    diagram: null,
    extraction: null,
    comparison: null,
    jobId: null,
  };
}

export class ImageIntelligenceManager {
  readonly limits: ImageLimits;
  private readonly files: FileIntelligenceManager;
  private readonly providers: ImageProviderRegistry;
  private readonly now: () => Date;
  private readonly sink?: ImageAuditSink;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly records = new Map<string, AnalysisRecord>();

  constructor(options: ImageIntelligenceOptions) {
    this.files = options.files;
    this.providers = options.providers;
    this.limits = resolveImageLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.sink = options.audit;
  }

  /** True when every configured provider is a simulation (honest UI labels). */
  get providerIsSimulation(): boolean {
    const list = this.providers.list();
    return list.length > 0 && list.every((p) => p.id.includes('mock'));
  }

  private audit(
    type: string,
    ownerRef: string,
    extra: Record<string, string | number | null> = {},
  ) {
    this.sink?.record({ type, ownerRef, ...extra });
  }

  /** Map Step 19 errors to honest image-layer codes. */
  private mapFileError(error: unknown): never {
    if (isFileIntelligenceError(error)) {
      const code = (error as FileIntelligenceError).code;
      if (code === 'FILE_UNAUTHORIZED') throw new ImageIntelligenceError('IMAGE_UNAUTHORIZED');
      if (code === 'FILE_NOT_FOUND') throw new ImageIntelligenceError('IMAGE_FILE_NOT_FOUND');
      if (code === 'FILE_EXPIRED' || code === 'FILE_DELETED')
        throw new ImageIntelligenceError('IMAGE_EXPIRED');
      if (code === 'FILE_TYPE_REJECTED')
        throw new ImageIntelligenceError('IMAGE_UNSUPPORTED_FORMAT');
      if (code === 'FILE_LIMIT_EXCEEDED') throw new ImageIntelligenceError('IMAGE_LIMIT_EXCEEDED');
    }
    throw new ImageIntelligenceError('IMAGE_FILE_NOT_FOUND', 'Image file was not found.');
  }

  /** Authorized, integrity-checked bytes + honest signature-derived metadata. */
  private async requireImage(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{ file: FileAsset; bytes: Uint8Array; mimeType: string; format: ImageFormat | null }> {
    let file: FileAsset;
    let bytes: Uint8Array;
    let mimeType: string;
    try {
      file = await this.files.getFile(fileId, principal);
      const fetched = await this.files.imageBytes(fileId, principal);
      bytes = fetched.bytes;
      mimeType = fetched.mimeType;
    } catch (error) {
      this.mapFileError(error);
    }
    if (file!.metadata.category !== 'image')
      throw new ImageIntelligenceError('IMAGE_UNSUPPORTED_FORMAT', 'File is not an image.');
    const format = detectImageFormat(bytes!);
    if (format === 'svg' && svgHasScript(bytes!))
      throw new ImageIntelligenceError(
        'IMAGE_UNSAFE_IMAGE',
        'SVG content containing scripts is rejected.',
      );
    const dimensions = format === 'png' ? pngDimensions(bytes!) : null;
    if (
      dimensions &&
      !withinDimensionCeiling(dimensions.width, dimensions.height, this.limits.maxDimensionPixels)
    )
      throw new ImageIntelligenceError(
        'IMAGE_LIMIT_EXCEEDED',
        'Image dimensions exceed the limit.',
        {
          width: dimensions.width,
          height: dimensions.height,
          limit: this.limits.maxDimensionPixels,
        },
      );
    return { file: file!, bytes: bytes!, mimeType: mimeType!, format };
  }

  private attachment(bytes: Uint8Array, mimeType: string): AIImageAttachment {
    return { base64Data: Buffer.from(bytes).toString('base64'), mimeType };
  }

  private providerFor(
    capability: Parameters<ImageProviderRegistry['findForCapability']>[0],
  ): ImageProvider {
    const provider = this.providers.findForCapability(capability);
    if (!provider)
      throw new ImageIntelligenceError(
        'IMAGE_CAPABILITY_UNSUPPORTED',
        `No configured provider supports ${capability}.`,
      );
    return provider;
  }

  private record(fileId: string): AnalysisRecord {
    let rec = this.records.get(fileId);
    if (!rec) {
      rec = emptyRecord();
      this.records.set(fileId, rec);
    }
    return rec;
  }

  /** Provider call with deadline enforcement and one-way cancellation. */
  private async callProvider(
    provider: ImageProvider,
    request: ImageProviderRequest,
    rec: JobRecord | null,
    deadlineMs: number,
  ): Promise<string> {
    if (rec?.cancelled) throw new ImageIntelligenceError('IMAGE_PROCESSING_CANCELLED');
    const remaining = deadlineMs - this.now().getTime();
    if (remaining <= 0)
      throw new ImageIntelligenceError(
        'IMAGE_PROVIDER_TIMEOUT',
        'Image processing exceeded the time limit.',
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ImageIntelligenceError(
              'IMAGE_PROVIDER_TIMEOUT',
              'Image processing exceeded the time limit.',
            ),
          ),
        Math.max(remaining, 1),
      );
    });
    try {
      const result = await Promise.race([provider.analyze(request), timeout]);
      if (rec?.cancelled) throw new ImageIntelligenceError('IMAGE_PROCESSING_CANCELLED');
      return result.text;
    } catch (error) {
      if (rec?.cancelled) throw new ImageIntelligenceError('IMAGE_PROCESSING_CANCELLED');
      if (error instanceof ImageIntelligenceError) throw error;
      // Unknown provider failures are scrubbed into a typed error.
      throw new ImageIntelligenceError('IMAGE_PROVIDER_ERROR', 'The image provider failed.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async inspect(fileId: FileAssetId, principal: FilePrincipal): Promise<ImageMetadata> {
    const { file, bytes, mimeType, format } = await this.requireImage(fileId, principal);
    const png = format === 'png' ? parsePngInfo(bytes) : null;
    const animation = parseAnimationInfo(bytes, format);
    this.audit('image_inspected', principal.ownerRef, { fileId: String(fileId) });
    return {
      fileId: file.id,
      filename: file.metadata.normalizedFilename,
      mimeType,
      format,
      byteSize: file.metadata.byteSize,
      checksum: file.metadata.checksum,
      width: format === 'png' && png ? (pngDimensions(bytes)?.width ?? null) : null,
      height: format === 'png' && png ? (pngDimensions(bytes)?.height ?? null) : null,
      colorInfo: png
        ? {
            bitDepth: png.bitDepth,
            colorType: png.colorType,
            hasAlpha: png.hasAlpha,
            dominantColors: [],
          }
        : null,
      animated: animation.animated,
      frameCount: animation.frameCount,
      createdAt: file.createdAt,
      scope: file.scope,
    };
  }

  async process(fileId: FileAssetId, principal: FilePrincipal): Promise<ImageProcessingJob> {
    this.expireJobs();
    const { file, bytes, mimeType, format } = await this.requireImage(fileId, principal);
    if (file.metadata.byteSize > this.limits.maxFileBytes)
      throw new ImageIntelligenceError(
        'IMAGE_LIMIT_EXCEEDED',
        'Image file exceeds the size limit.',
        {
          bytes: file.metadata.byteSize,
          limit: this.limits.maxFileBytes,
        },
      );
    const describeProvider = this.providerFor('image_understanding');
    const ocrProvider = this.providers.findForCapability('ocr');
    const operations = ocrProvider ? 2 : 1;
    const active = [...this.jobs.values()].filter((r) => !TERMINAL.includes(r.job.status));
    if (active.length >= this.limits.maxConcurrentJobs)
      throw new ImageIntelligenceError('IMAGE_LIMIT_EXCEEDED', 'Too many active image jobs.', {
        active: active.length,
        limit: this.limits.maxConcurrentJobs,
      });

    const now = this.now().toISOString();
    const id = newImageJobId();
    const rec: JobRecord = {
      job: {
        id: id as never,
        fileId,
        ownerRef: principal.ownerRef,
        projectId: file.scope.projectId,
        workspaceId: file.scope.workspaceId,
        status: 'received',
        stage: 'queued',
        operations,
        completedOperations: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(this.now().getTime() + this.limits.jobTtlSeconds * 1000).toISOString(),
      },
      cancelled: false,
    };
    this.jobs.set(id, rec);
    const step = (status: ImageProcessingStatus, stage: ImageProcessingJob['stage']) => {
      if (!TRANSITIONS[rec.job.status].includes(status))
        throw new ImageIntelligenceError(
          'IMAGE_INVALID_TRANSITION',
          `Cannot move job from ${rec.job.status} to ${status}.`,
        );
      rec.job = { ...rec.job, status, stage, updatedAt: this.now().toISOString() };
    };
    this.audit('image_processing_started', principal.ownerRef, {
      jobId: id,
      fileId: String(fileId),
    });
    const deadlineMs = this.now().getTime() + this.limits.maxProcessingMs;
    const attachment = this.attachment(bytes, mimeType);
    try {
      step('validating', 'validation');
      if (format === null)
        throw new ImageIntelligenceError(
          'IMAGE_UNSUPPORTED_FORMAT',
          'Image format could not be identified.',
        );
      step('validated', 'validation');
      step('processing', 'describe');
      const described = parseDescription(
        await this.callProvider(
          describeProvider,
          { op: 'describe', images: [attachment], isCancelled: () => rec.cancelled },
          rec,
          deadlineMs,
        ),
        describeProvider.id,
        fileId,
      );
      const analysis = this.record(String(fileId));
      analysis.description = described;
      analysis.jobId = id;
      rec.job = {
        ...rec.job,
        completedOperations: rec.job.completedOperations + 1,
        updatedAt: this.now().toISOString(),
      };
      this.audit('image_described', principal.ownerRef, {
        fileId: String(fileId),
        providerId: describeProvider.id,
      });
      step('analyzing', 'ocr');
      if (ocrProvider) {
        const ocr = parseOcrResult(
          await this.callProvider(
            ocrProvider,
            { op: 'ocr', images: [attachment], isCancelled: () => rec.cancelled },
            rec,
            deadlineMs,
          ),
          ocrProvider.id,
          fileId,
          file.metadata.checksum,
          null,
          this.now().toISOString(),
          this.limits.maxOcrCharacters,
        );
        analysis.ocr = ocr;
        rec.job = {
          ...rec.job,
          completedOperations: rec.job.completedOperations + 1,
          updatedAt: this.now().toISOString(),
        };
        this.audit('image_ocr_completed', principal.ownerRef, {
          fileId: String(fileId),
          regionCount: ocr.regions.length,
        });
      } else {
        rec.job = { ...rec.job, completedOperations: rec.job.completedOperations + 1 };
      }
      step('completed', 'done');
      this.audit('image_job_completed', principal.ownerRef, { jobId: id, fileId: String(fileId) });
      return rec.job;
    } catch (error) {
      const cancelled =
        (error instanceof ImageIntelligenceError && error.code === 'IMAGE_PROCESSING_CANCELLED') ||
        rec.cancelled ||
        rec.job.status === 'cancelled';
      const code = error instanceof ImageIntelligenceError ? error.code : 'IMAGE_PROVIDER_ERROR';
      rec.job = {
        ...rec.job,
        status: cancelled ? 'cancelled' : 'failed',
        stage: 'done',
        error: {
          code,
          message: error instanceof Error ? error.message : 'Image processing failed.',
        },
        updatedAt: this.now().toISOString(),
      };
      this.audit(cancelled ? 'image_job_cancelled' : 'image_job_failed', principal.ownerRef, {
        jobId: id,
        code,
      });
      return rec.job;
    }
  }

  private expireJobs() {
    const nowMs = this.now().getTime();
    for (const rec of this.jobs.values()) {
      if (
        TERMINAL.includes(rec.job.status) &&
        rec.job.status !== 'expired' &&
        Date.parse(rec.job.expiresAt) <= nowMs
      ) {
        rec.job = { ...rec.job, status: 'expired', updatedAt: this.now().toISOString() };
      }
    }
  }

  getJob(jobId: string, principal: FilePrincipal): ImageProcessingJob {
    this.expireJobs();
    const rec = this.jobs.get(jobId);
    if (!rec) throw new ImageIntelligenceError('IMAGE_JOB_NOT_FOUND', 'Image job was not found.');
    if (rec.job.ownerRef !== principal.ownerRef)
      throw new ImageIntelligenceError('IMAGE_UNAUTHORIZED', 'Image job access was denied.');
    return rec.job;
  }

  listJobs(principal: FilePrincipal): readonly ImageProcessingJob[] {
    this.expireJobs();
    return [...this.jobs.values()]
      .map((r) => r.job)
      .filter((j) => j.ownerRef === principal.ownerRef)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  /** One-way cancellation; idempotent once terminal. Audited. */
  cancelJob(jobId: string, principal: FilePrincipal): ImageProcessingJob {
    const rec = this.jobs.get(jobId);
    if (!rec) throw new ImageIntelligenceError('IMAGE_JOB_NOT_FOUND', 'Image job was not found.');
    if (rec.job.ownerRef !== principal.ownerRef)
      throw new ImageIntelligenceError('IMAGE_UNAUTHORIZED', 'Image job access was denied.');
    if (TERMINAL.includes(rec.job.status)) return rec.job;
    rec.cancelled = true;
    rec.job = {
      ...rec.job,
      status: 'cancelled',
      stage: 'done',
      updatedAt: this.now().toISOString(),
    };
    this.audit('image_job_cancelled', principal.ownerRef, { jobId });
    return rec.job;
  }

  /** Stored description + OCR for a processed image. */
  async analysis(fileId: FileAssetId, principal: FilePrincipal): Promise<ImageAnalysisRecord> {
    await this.requireImage(fileId, principal);
    const rec = this.records.get(String(fileId));
    if (!rec || (!rec.description && !rec.ocr))
      throw new ImageIntelligenceError('IMAGE_NOT_PROCESSED');
    return { description: rec.description, ocr: rec.ocr, jobId: (rec.jobId ?? null) as never };
  }

  private async ocrFor(fileId: FileAssetId, principal: FilePrincipal): Promise<OcrResult> {
    const rec = this.records.get(String(fileId));
    if (!rec?.ocr) throw new ImageIntelligenceError('IMAGE_NOT_PROCESSED');
    await this.requireImage(fileId, principal);
    return this.records.get(String(fileId))!.ocr!;
  }

  async describe(fileId: FileAssetId, principal: FilePrincipal): Promise<ImageDescription> {
    const rec = this.records.get(String(fileId));
    if (rec?.description) {
      await this.requireImage(fileId, principal);
      return rec.description;
    }
    const { bytes, mimeType } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('image_understanding');
    const described = parseDescription(
      await this.callProvider(
        provider,
        {
          op: 'describe',
          images: [this.attachment(bytes, mimeType)],
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
    );
    this.record(String(fileId)).description = described;
    this.audit('image_described', principal.ownerRef, {
      fileId: String(fileId),
      providerId: provider.id,
    });
    return described;
  }

  async query(
    fileId: FileAssetId,
    question: string,
    principal: FilePrincipal,
  ): Promise<ImageQueryResult> {
    const q = question.trim();
    if (!q) throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'A question is required.');
    const { bytes, mimeType } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('visual_question_answering');
    const parsed = parseQueryResult(
      await this.callProvider(
        provider,
        {
          op: 'query',
          images: [this.attachment(bytes, mimeType)],
          question: q,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      q,
    );
    this.audit('image_query_answered', principal.ownerRef, { fileId: String(fileId) });
    return parsed;
  }

  async screenshot(fileId: FileAssetId, principal: FilePrincipal): Promise<ScreenshotAnalysis> {
    const ocr = await this.ocrFor(fileId, principal);
    const { bytes, mimeType } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('screenshot_understanding');
    const realRegions = new Set(ocr.regions.map((r) => r.id));
    const analysis = parseScreenshotAnalysis(
      await this.callProvider(
        provider,
        { op: 'screenshot', images: [this.attachment(bytes, mimeType)], isCancelled: () => false },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      realRegions,
    );
    this.record(String(fileId)).screenshot = analysis;
    this.audit('image_screenshot_analyzed', principal.ownerRef, {
      fileId: String(fileId),
      issueCount: analysis.issues.length,
    });
    return analysis;
  }

  async uiStructure(fileId: FileAssetId, principal: FilePrincipal): Promise<UiStructure> {
    const ocr = await this.ocrFor(fileId, principal);
    const { bytes, mimeType, file } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('ui_element_detection');
    const realRegions = new Set(ocr.regions.map((r) => r.id));
    const structure = parseUiStructure(
      await this.callProvider(
        provider,
        {
          op: 'ui_structure',
          images: [this.attachment(bytes, mimeType)],
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
      realRegions,
    );
    this.record(String(fileId)).uiStructure = structure;
    this.audit('image_ui_extracted', principal.ownerRef, {
      fileId: String(fileId),
      elementCount: structure.elements.length,
    });
    return structure;
  }

  async chart(fileId: FileAssetId, principal: FilePrincipal): Promise<ChartAnalysis> {
    const { bytes, mimeType } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('chart_understanding');
    const analysis = parseChartAnalysis(
      await this.callProvider(
        provider,
        { op: 'chart', images: [this.attachment(bytes, mimeType)], isCancelled: () => false },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
    );
    this.record(String(fileId)).chart = analysis;
    this.audit('image_chart_analyzed', principal.ownerRef, { fileId: String(fileId) });
    return analysis;
  }

  async diagram(fileId: FileAssetId, principal: FilePrincipal): Promise<DiagramAnalysis> {
    const { bytes, mimeType, file } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('diagram_understanding');
    const analysis = parseDiagramAnalysis(
      await this.callProvider(
        provider,
        { op: 'diagram', images: [this.attachment(bytes, mimeType)], isCancelled: () => false },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
    );
    this.record(String(fileId)).diagram = analysis;
    this.audit('image_diagram_analyzed', principal.ownerRef, { fileId: String(fileId) });
    return analysis;
  }

  async extract(
    fileId: FileAssetId,
    fields: readonly string[],
    principal: FilePrincipal,
  ): Promise<ImageExtraction> {
    const wanted = fields.filter((f) => typeof f === 'string' && f.trim()).slice(0, 20);
    const { bytes, mimeType } = await this.requireImage(fileId, principal);
    const provider = this.providerFor('structured_extraction');
    const extraction = parseExtraction(
      await this.callProvider(
        provider,
        {
          op: 'extract',
          images: [this.attachment(bytes, mimeType)],
          fields: wanted,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
    );
    this.record(String(fileId)).extraction = extraction;
    this.audit('image_extraction_run', principal.ownerRef, { fileId: String(fileId) });
    return extraction;
  }

  async compare(
    fileAId: FileAssetId,
    fileBId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<ComparisonResult> {
    const a = await this.requireImage(fileAId, principal);
    const b = await this.requireImage(fileBId, principal);
    const provider = this.providerFor('comparison');
    const result = parseComparisonResult(
      await this.callProvider(
        provider,
        {
          op: 'compare',
          images: [
            this.attachment(a.bytes, a.mimeType),
            this.attachment(b.bytes, b.mimeType),
          ].slice(0, Math.max(2, this.limits.maxCompareImages)),
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileAId,
      fileBId,
    );
    this.record(String(fileAId)).comparison = result;
    this.audit('image_compared', principal.ownerRef, {
      fileAId: String(fileAId),
      fileBId: String(fileBId),
    });
    return result;
  }

  /** Deterministic search within one image's stored (untrusted) text. */
  async searchImage(
    fileId: FileAssetId,
    query: string,
    principal: FilePrincipal,
  ): Promise<ImageSearchResult> {
    await this.requireImage(fileId, principal);
    const q = query.trim().toLowerCase();
    if (!q)
      throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'A search query is required.');
    const rec = this.records.get(String(fileId));
    const matches: ImageSearchMatch[] = [];
    const regions = rec?.ocr?.regions ?? [];
    for (const region of regions) {
      if (region.text.toLowerCase().includes(q))
        matches.push({ fileId, reason: 'ocr_region', matchedText: region.text.slice(0, 200) });
    }
    const description = rec?.description;
    if (description) {
      const haystacks = [description.summary, ...description.observed, ...description.inferences];
      for (const hay of haystacks) {
        if (hay.toLowerCase().includes(q))
          matches.push({ fileId, reason: 'description', matchedText: hay.slice(0, 200) });
      }
    }
    const capped = matches.slice(0, this.limits.maxSearchMatches);
    this.audit('image_search_performed', principal.ownerRef, { matchCount: capped.length });
    return {
      query: q,
      matches: capped,
      truncated: matches.length > capped.length,
      trust: 'untrusted_data',
    };
  }

  /** Deterministic search across a principal's processed images (bounded). */
  async searchImages(
    query: string,
    principal: FilePrincipal,
    filter: { projectId?: string | null } = {},
  ): Promise<ImageSearchResult> {
    const q = query.trim().toLowerCase();
    if (!q)
      throw new ImageIntelligenceError('IMAGE_INVALID_REQUEST', 'A search query is required.');
    const matches: ImageSearchMatch[] = [];
    let truncated = false;
    for (const [fileId, rec] of this.records) {
      if (matches.length >= this.limits.maxSearchMatches) {
        truncated = true;
        break;
      }
      let file: FileAsset;
      try {
        file = await this.files.getFile(fileId as FileAssetId, principal);
      } catch {
        continue; // authorization failures just exclude the record
      }
      if (filter.projectId !== undefined && file.scope.projectId !== filter.projectId) continue;
      const haystacks: string[] = [];
      if (rec.ocr) haystacks.push(rec.ocr.text, ...rec.ocr.regions.map((r) => r.text));
      if (rec.description) haystacks.push(rec.description.summary, ...rec.description.observed);
      const hit = haystacks.find((h) => h.toLowerCase().includes(q));
      if (hit)
        matches.push({
          fileId: file.id,
          reason: 'stored_text',
          matchedText: hit.slice(0, 200),
        });
    }
    this.audit('image_search_performed', principal.ownerRef, { matchCount: matches.length });
    return { query: q, matches, truncated, trust: 'untrusted_data' };
  }

  /** Persist a derived artifact through the Step 19 file system. */
  async saveArtifact(
    fileId: FileAssetId,
    principal: FilePrincipal,
    draft: { kind: ImageArtifactKind },
  ): Promise<ImageArtifactView> {
    const { file } = await this.requireImage(fileId, principal);
    const rec = this.records.get(String(fileId));
    const base = file.metadata.normalizedFilename.replace(/\.[^.]+$/, '');
    const needs = (
      present: boolean,
      missingCode: 'IMAGE_NOT_PROCESSED' | 'IMAGE_ARTIFACT_INVALID',
    ) => {
      if (!present) throw new ImageIntelligenceError(missingCode);
    };
    const buffer = (text: string) => Buffer.from(text, 'utf8');
    let filename: string;
    let mimeType: string;
    let bytes: Buffer;
    switch (draft.kind) {
      case 'image_analysis_json': {
        needs(!!(rec?.description || rec?.ocr), 'IMAGE_NOT_PROCESSED');
        filename = `${base}-analysis.json`;
        mimeType = 'application/json';
        bytes = buffer(
          JSON.stringify({ description: rec?.description ?? null, ocr: rec?.ocr ?? null }, null, 2),
        );
        break;
      }
      case 'image_description_md': {
        needs(!!rec?.description, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-description.md`;
        mimeType = 'text/markdown';
        const d = rec!.description!;
        bytes = buffer(
          `# Image description: ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated interpretation. Not a direct image fact.\n\n${d.summary}\n\n` +
            (d.observed.length
              ? `## Observed (provider-reported facts)\n${d.observed.map((o) => `- ${o}`).join('\n')}\n`
              : '') +
            (d.inferences.length
              ? `## Inferences (AI guesses)\n${d.inferences.map((o) => `- ${o}`).join('\n')}\n`
              : ''),
        );
        break;
      }
      case 'ocr_txt': {
        needs(!!rec?.ocr, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-ocr.txt`;
        mimeType = 'text/plain';
        bytes = buffer(
          `# Untrusted data extracted from ${file.metadata.normalizedFilename}\n\n${rec!.ocr!.text}`,
        );
        break;
      }
      case 'screenshot_analysis_md': {
        needs(!!rec?.screenshot, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-screenshot.md`;
        mimeType = 'text/markdown';
        const s = rec!.screenshot!;
        bytes = buffer(
          `# Screenshot analysis: ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated interpretation. Not a direct screenshot fact.\n\n` +
            s.issues.map((i) => `- **${i.kind}** (${i.basis}): ${i.statement}`).join('\n'),
        );
        break;
      }
      case 'ui_structure_json': {
        needs(!!rec?.uiStructure, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-ui-structure.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.uiStructure!, null, 2));
        break;
      }
      case 'image_comparison_json': {
        needs(!!rec?.comparison, 'IMAGE_ARTIFACT_INVALID');
        filename = `${base}-comparison.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.comparison!, null, 2));
        break;
      }
      case 'chart_analysis_json': {
        needs(!!rec?.chart, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-chart.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.chart!, null, 2));
        break;
      }
      case 'diagram_analysis_json': {
        needs(!!rec?.diagram, 'IMAGE_NOT_PROCESSED');
        filename = `${base}-diagram.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.diagram!, null, 2));
        break;
      }
      default:
        throw new ImageIntelligenceError('IMAGE_ARTIFACT_INVALID', 'Unknown artifact kind.');
    }
    const saved = await this.files.registerFile({
      filename,
      bytes,
      declaredMimeType: mimeType,
      source: 'derived_extraction',
      scope: file.scope,
      parentFileId: fileId,
    });
    this.audit('image_artifact_saved', principal.ownerRef, {
      fileId: String(fileId),
      kind: draft.kind,
      filename: saved.metadata.normalizedFilename,
    });
    return {
      id: saved.id,
      filename: saved.metadata.normalizedFilename,
      mimeType: saved.metadata.detectedMimeType ?? mimeType,
      byteSize: saved.metadata.byteSize,
      checksum: saved.metadata.checksum,
      createdAt: saved.createdAt,
      projectId: saved.scope.projectId,
      workspaceId: saved.scope.workspaceId,
    };
  }

  /** Authorized image bytes for display. Integrity-checked on every read. */
  async mediaBytes(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    try {
      const fetched = await this.files.imageBytes(fileId, principal);
      return { bytes: fetched.bytes, mimeType: fetched.mimeType };
    } catch (error) {
      this.mapFileError(error);
    }
  }

  /** Declared capability surface - honest, including simulation status. */
  capabilities(): {
    providers: readonly ImageProviderCapabilities[];
    operations: readonly string[];
    limits: ImageLimits;
  } {
    return {
      providers: this.providers.list().map((p) => p.getCapabilities()),
      operations: [...IMAGE_PROVIDER_OPERATIONS],
      limits: this.limits,
    };
  }
}

export { isFileIntelligenceError, formatFromMime, parseProviderJson };

/**
 * VideoIntelligenceManager - bounded, auditable multimodal video
 * understanding on top of the Step 19 File Intelligence system.
 *
 * Security invariants:
 * - Video content is UNTRUSTED DATA in every modality: spoken words,
 *   subtitles, visible screen text, and OCR output are untrusted data;
 *   scene, timeline, and Q&A output is ai_generated interpretation.
 *   Nothing here executes tools, mutates projects, or treats any of that
 *   text as authorization - a video that says "delete this project" is
 *   content being analyzed, never an instruction.
 * - Every read re-authorizes through FileIntelligenceManager (scope,
 *   expiry, integrity) - the video layer adds no second trust path.
 * - Formats are detected from magic bytes and container boxes, never from
 *   declared MIME types; malformed containers fail closed.
 * - Timestamps are never invented: providers' timestamps outside the
 *   genuine container duration are dropped, and evidence references are
 *   INDEXES mapped onto manager-minted ids - forged refs are dropped.
 * - Speaker labels are neutral and index-derived only; identity is never
 *   inferred from voice.
 * - All processing is bounded: bytes, duration, dimensions, frame rate,
 *   streams, frames, transcript size, concurrency, wall-clock time.
 * - Cancellation is one-way and audited; jobs expire.
 * - Audit metadata never contains video content, transcript text, or OCR.
 */
import {
  FileIntelligenceError,
  isFileIntelligenceError,
  type FileAsset,
  type FileAssetId,
  type FileIntelligenceManager,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';
import { VideoIntelligenceError } from '../errors/index.js';
import { resolveVideoLimits } from '../limits/index.js';
import type { VideoAuditSink } from '../audit/index.js';
import {
  detectVideoFormat,
  newVideoJobId,
  parseMp4Container,
  withinDimensionCeiling,
} from '../security/index.js';
import {
  parseComparisonResult,
  parseDescription,
  parseExtraction,
  parseFrames,
  parseOcrResult,
  parseProviderJson,
  parseQueryResult,
  parseScenes,
  parseSummary,
  parseTimeline,
  parseTranscript,
  parseTranslation,
} from '../reasoning/index.js';
import { VideoProviderRegistry } from '../provider/index.js';
import {
  VIDEO_PROVIDER_OPERATIONS,
  type FilePrincipal as _Principal,
  type FrameRequestOptions,
  type FrameStrategy,
  type VideoAnalysisRecord,
  type VideoArtifactKind,
  type VideoArtifactView,
  type VideoComparisonResult,
  type VideoContainerInfo,
  type VideoDescription,
  type VideoExtraction,
  type VideoFormat,
  type VideoFrame,
  type VideoFrameExtraction,
  type VideoLimits,
  type VideoMetadata,
  type VideoOcrResult,
  type VideoProcessingJob,
  type VideoProcessingStatus,
  type VideoProvider,
  type VideoProviderCapabilities,
  type VideoProviderRequest,
  type VideoQueryResult,
  type VideoScene,
  type VideoSceneAnalysis,
  type VideoSearchMatch,
  type VideoSearchResult,
  type VideoSummary,
  type VideoSummaryMode,
  type VideoTimeline,
  type VideoTranscript,
  type VideoTranslation,
} from '../types/index.js';

export interface VideoIntelligenceOptions {
  /** Step 19 manager: bytes, metadata, scope authorization. */
  readonly files: FileIntelligenceManager;
  /** Registry of configured providers (mock or real adapters). */
  readonly providers: VideoProviderRegistry;
  readonly limits?: Partial<VideoLimits>;
  readonly now?: () => Date;
  /** Optional audit sink; events are scrubbed metadata only. */
  readonly audit?: VideoAuditSink;
}

interface JobRecord {
  job: VideoProcessingJob;
  cancelled: boolean;
}

interface AnalysisRecord {
  description: VideoDescription | null;
  transcript: VideoTranscript | null;
  scenes: VideoSceneAnalysis | null;
  ocr: VideoOcrResult | null;
  timeline: VideoTimeline | null;
  summary: VideoSummary | null;
  extraction: VideoExtraction | null;
  translation: VideoTranslation | null;
  comparison: VideoComparisonResult | null;
  frames: VideoFrame[];
  framesExtracted: number;
  jobId: string | null;
}

const TERMINAL: readonly VideoProcessingStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
const TRANSITIONS: Record<VideoProcessingStatus, readonly VideoProcessingStatus[]> = {
  received: ['validating', 'cancelled'],
  validating: ['validated', 'failed', 'cancelled'],
  validated: ['processing', 'failed', 'cancelled'],
  processing: ['extracting', 'failed', 'cancelled'],
  extracting: ['analyzing', 'failed', 'cancelled'],
  analyzing: ['completed', 'failed', 'cancelled'],
  completed: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
};

const FRAME_STRATEGIES: readonly FrameStrategy[] = [
  'first',
  'last',
  'timestamp',
  'even',
  'scene',
  'keyframe',
];

function emptyRecord(): AnalysisRecord {
  return {
    description: null,
    transcript: null,
    scenes: null,
    ocr: null,
    timeline: null,
    summary: null,
    extraction: null,
    translation: null,
    comparison: null,
    frames: [],
    framesExtracted: 0,
    jobId: null,
  };
}

const noFrames: readonly VideoFrame[] = [];

export class VideoIntelligenceManager {
  readonly limits: VideoLimits;
  private readonly files: FileIntelligenceManager;
  private readonly providers: VideoProviderRegistry;
  private readonly now: () => Date;
  private readonly sink?: VideoAuditSink;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly records = new Map<string, AnalysisRecord>();
  private activeProviderCalls = 0;

  constructor(options: VideoIntelligenceOptions) {
    this.files = options.files;
    this.providers = options.providers;
    this.limits = resolveVideoLimits(options.limits);
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

  /** Map Step 19 errors to honest video-layer codes. */
  private mapFileError(error: unknown): never {
    if (isFileIntelligenceError(error)) {
      const code = (error as FileIntelligenceError).code;
      if (code === 'FILE_UNAUTHORIZED') throw new VideoIntelligenceError('VIDEO_UNAUTHORIZED');
      if (code === 'FILE_NOT_FOUND') throw new VideoIntelligenceError('VIDEO_FILE_NOT_FOUND');
      if (code === 'FILE_EXPIRED' || code === 'FILE_DELETED')
        throw new VideoIntelligenceError('VIDEO_EXPIRED');
      if (code === 'FILE_TYPE_REJECTED')
        throw new VideoIntelligenceError('VIDEO_UNSUPPORTED_FORMAT');
      if (code === 'FILE_LIMIT_EXCEEDED') throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    }
    throw new VideoIntelligenceError('VIDEO_FILE_NOT_FOUND', 'Video file was not found.');
  }

  /** Authorized, integrity-checked bytes + signature-derived facts. */
  private async requireVideo(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{
    file: FileAsset;
    bytes: Uint8Array;
    mimeType: string;
    format: VideoFormat | null;
    container: VideoContainerInfo;
  }> {
    let file: FileAsset;
    let bytes: Uint8Array;
    let mimeType: string;
    try {
      file = await this.files.getFile(fileId, principal);
      const fetched = await this.files.videoBytes(fileId, principal);
      bytes = fetched.bytes;
      mimeType = fetched.mimeType;
    } catch (error) {
      this.mapFileError(error);
    }
    if (file!.metadata.category !== 'video')
      throw new VideoIntelligenceError('VIDEO_UNSUPPORTED_FORMAT', 'File is not a video.');
    if (bytes!.length > this.limits.maxFileBytes)
      throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    const format = detectVideoFormat(bytes!);
    if (format === null)
      throw new VideoIntelligenceError(
        'VIDEO_UNSUPPORTED_FORMAT',
        'Video format could not be identified by signature.',
      );
    const container = parseMp4Container(bytes!);
    if (!withinDimensionCeiling(container.width, container.height, this.limits.maxDimensionPixels))
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Video dimensions exceed the limit.',
        {
          width: container.width,
          height: container.height,
          limit: this.limits.maxDimensionPixels,
        },
      );
    if (
      container.durationSeconds !== null &&
      container.durationSeconds > this.limits.maxDurationSeconds
    )
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Video duration exceeds the limit.',
        {
          durationSeconds: container.durationSeconds,
          limit: this.limits.maxDurationSeconds,
        },
      );
    if (container.frameRate !== null && container.frameRate > this.limits.maxFrameRate)
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Video frame rate exceeds the limit.',
      );
    if (container.streamCount !== null && container.streamCount > this.limits.maxStreams)
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Video stream count exceeds the limit.',
      );
    return { file: file!, bytes: bytes!, mimeType: mimeType!, format, container };
  }

  private attachment(bytes: Uint8Array, mimeType: string) {
    return { base64Data: Buffer.from(bytes).toString('base64'), mimeType };
  }

  private providerFor(
    capability: Parameters<VideoProviderRegistry['findForCapability']>[0],
  ): VideoProvider {
    const provider = this.providers.findForCapability(capability);
    if (!provider)
      throw new VideoIntelligenceError(
        'VIDEO_CAPABILITY_UNSUPPORTED',
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
    provider: VideoProvider,
    request: VideoProviderRequest,
    rec: JobRecord | null,
    deadlineMs: number,
  ): Promise<string> {
    if (rec?.cancelled) throw new VideoIntelligenceError('VIDEO_PROCESSING_CANCELLED');
    const caps = provider.getCapabilities();
    for (const a of [request.video, ...(request.other ? [request.other] : [])])
      if (caps.maxBytes !== null && Buffer.byteLength(a.base64Data, 'base64') > caps.maxBytes)
        throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    if (
      caps.supportedFormats !== null &&
      request.media.format !== null &&
      !caps.supportedFormats.includes(request.media.format)
    )
      throw new VideoIntelligenceError('VIDEO_CAPABILITY_UNSUPPORTED');
    if (
      caps.maxDurationSeconds !== null &&
      request.media.durationSeconds !== null &&
      request.media.durationSeconds > caps.maxDurationSeconds
    )
      throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    const remaining = deadlineMs - this.now().getTime();
    if (remaining <= 0)
      throw new VideoIntelligenceError(
        'VIDEO_PROVIDER_TIMEOUT',
        'Video processing exceeded the time limit.',
      );
    if (this.activeProviderCalls >= this.limits.maxConcurrentJobs)
      throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    this.activeProviderCalls++;
    let timedOut = false;
    const boundedRequest = {
      ...request,
      isCancelled: () => timedOut || !!rec?.cancelled || request.isCancelled(),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          reject(
            new VideoIntelligenceError(
              'VIDEO_PROVIDER_TIMEOUT',
              'Video processing exceeded the time limit.',
            ),
          );
        },
        Math.max(remaining, 1),
      );
    });
    try {
      const result = await Promise.race([provider.analyze(boundedRequest), timeout]);
      if (rec?.cancelled) throw new VideoIntelligenceError('VIDEO_PROCESSING_CANCELLED');
      return result.text;
    } catch (error) {
      if (rec?.cancelled) throw new VideoIntelligenceError('VIDEO_PROCESSING_CANCELLED');
      if (error instanceof VideoIntelligenceError) throw error;
      throw new VideoIntelligenceError('VIDEO_PROVIDER_ERROR', 'The video provider failed.');
    } finally {
      this.activeProviderCalls--;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async inspect(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoMetadata> {
    const { file, mimeType, format, container } = await this.requireVideo(fileId, principal);
    return {
      fileId,
      filename: file.metadata.normalizedFilename,
      mimeType: mimeType || file.metadata.detectedMimeType || 'video/mp4',
      format,
      byteSize: file.metadata.byteSize,
      checksum: file.metadata.checksum,
      container,
      createdAt: file.createdAt,
      scope: file.scope,
    };
  }

  async process(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoProcessingJob> {
    this.expireJobs();
    const { file, bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    if (file.metadata.byteSize > this.limits.maxFileBytes)
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Video file exceeds the size limit.',
        {
          bytes: file.metadata.byteSize,
          limit: this.limits.maxFileBytes,
        },
      );
    const describeProvider = this.providerFor('video_understanding');
    const transcriber = this.providers.findForCapability('transcription');
    const sceneProvider = this.providers.findForCapability('scene_detection');
    const ocrProvider = this.providers.findForCapability('ocr');
    const operations = 1 + (transcriber ? 1 : 0) + (sceneProvider ? 1 : 0) + (ocrProvider ? 1 : 0);
    const active = [...this.jobs.values()].filter((r) => !TERMINAL.includes(r.job.status));
    if (active.length >= this.limits.maxConcurrentJobs)
      throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED', 'Too many active video jobs.', {
        active: active.length,
        limit: this.limits.maxConcurrentJobs,
      });

    const now = this.now().toISOString();
    const id = newVideoJobId();
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
    const step = (status: VideoProcessingStatus, stage: VideoProcessingJob['stage']) => {
      if (!TRANSITIONS[rec.job.status].includes(status))
        throw new VideoIntelligenceError(
          'VIDEO_INVALID_TRANSITION',
          `Cannot move job from ${rec.job.status} to ${status}.`,
        );
      rec.job = { ...rec.job, status, stage, updatedAt: this.now().toISOString() };
    };
    this.audit('video_processing_started', principal.ownerRef, {
      jobId: id,
      fileId: String(fileId),
    });
    const deadlineMs = this.now().getTime() + this.limits.maxProcessingMs;
    const attachment = this.attachment(bytes, mimeType);
    const media = {
      format,
      durationSeconds: container.durationSeconds,
      width: container.width,
      height: container.height,
    };
    const advance = () =>
      (rec.job = {
        ...rec.job,
        completedOperations: rec.job.completedOperations + 1,
        updatedAt: this.now().toISOString(),
      });
    const analysis = this.record(String(fileId));
    const knownFrameIds = analysis.frames.map((f) => f.id);
    try {
      step('validating', 'validation');
      if (format === null)
        throw new VideoIntelligenceError(
          'VIDEO_UNSUPPORTED_FORMAT',
          'Video format could not be identified.',
        );
      step('validated', 'validation');
      step('processing', 'describe');
      analysis.description = parseDescription(
        await this.callProvider(
          describeProvider,
          { op: 'process', video: attachment, media, isCancelled: () => rec.cancelled },
          rec,
          deadlineMs,
        ),
        describeProvider.id,
        fileId,
      );
      analysis.jobId = id;
      advance();
      this.audit('video_described', principal.ownerRef, {
        fileId: String(fileId),
        providerId: describeProvider.id,
      });
      step('extracting', 'transcript');
      if (transcriber) {
        const { transcript } = parseTranscript(
          await this.callProvider(
            transcriber,
            { op: 'transcript', video: attachment, media, isCancelled: () => rec.cancelled },
            rec,
            deadlineMs,
          ),
          transcriber.id,
          fileId,
          file.metadata.checksum,
          container.durationSeconds,
          2000,
          this.limits.maxTranscriptCharacters,
        );
        analysis.transcript = transcript;
        advance();
        this.audit('video_transcribed', principal.ownerRef, {
          fileId: String(fileId),
          segmentCount: transcript.segments.length,
        });
      }
      if (sceneProvider) {
        const { scenes } = parseScenes(
          await this.callProvider(
            sceneProvider,
            { op: 'scenes', video: attachment, media, isCancelled: () => rec.cancelled },
            rec,
            deadlineMs,
          ),
          sceneProvider.id,
          fileId,
          file.metadata.checksum,
          container.durationSeconds,
          knownFrameIds,
          64,
        );
        analysis.scenes = {
          fileId,
          scenes,
          truncated: false,
          providerId: sceneProvider.id,
          trust: 'ai_generated',
        };
        advance();
        this.audit('video_scenes_detected', principal.ownerRef, {
          fileId: String(fileId),
          sceneCount: scenes.length,
        });
      }
      step('analyzing', 'ocr');
      if (ocrProvider) {
        const { ocr } = parseOcrResult(
          await this.callProvider(
            ocrProvider,
            { op: 'ocr', video: attachment, media, isCancelled: () => rec.cancelled },
            rec,
            deadlineMs,
          ),
          ocrProvider.id,
          fileId,
          file.metadata.checksum,
          this.now().toISOString(),
          container.durationSeconds,
          knownFrameIds,
          200,
          this.limits.maxOcrCharacters,
        );
        analysis.ocr = ocr;
        advance();
        this.audit('video_ocr_completed', principal.ownerRef, {
          fileId: String(fileId),
          entryCount: ocr.entries.length,
        });
      }
      step('completed', 'done');
      this.audit('video_job_completed', principal.ownerRef, { jobId: id, fileId: String(fileId) });
      return rec.job;
    } catch (error) {
      const cancelled =
        (error instanceof VideoIntelligenceError && error.code === 'VIDEO_PROCESSING_CANCELLED') ||
        rec.cancelled ||
        rec.job.status === 'cancelled';
      const code = error instanceof VideoIntelligenceError ? error.code : 'VIDEO_PROVIDER_ERROR';
      rec.job = {
        ...rec.job,
        status: cancelled ? 'cancelled' : 'failed',
        stage: 'done',
        error: {
          code,
          message: error instanceof Error ? error.message : 'Video processing failed.',
        },
        updatedAt: this.now().toISOString(),
      };
      this.audit(cancelled ? 'video_job_cancelled' : 'video_job_failed', principal.ownerRef, {
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

  private jobAllowed(job: VideoProcessingJob, p: FilePrincipal): boolean {
    return (
      job.ownerRef === p.ownerRef &&
      (!p.allowedProjectIds ||
        (job.projectId !== null && p.allowedProjectIds.includes(job.projectId))) &&
      (!p.allowedWorkspaceIds ||
        (job.workspaceId !== null && p.allowedWorkspaceIds.includes(job.workspaceId)))
    );
  }
  getJob(jobId: string, principal: FilePrincipal): VideoProcessingJob {
    this.expireJobs();
    const rec = this.jobs.get(jobId);
    if (!rec) throw new VideoIntelligenceError('VIDEO_JOB_NOT_FOUND', 'Video job was not found.');
    if (!this.jobAllowed(rec.job, principal))
      throw new VideoIntelligenceError('VIDEO_UNAUTHORIZED', 'Video job access was denied.');
    return rec.job;
  }

  listJobs(principal: FilePrincipal): readonly VideoProcessingJob[] {
    this.expireJobs();
    return [...this.jobs.values()]
      .map((r) => r.job)
      .filter((j) => this.jobAllowed(j, principal))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  /** One-way cancellation; idempotent once terminal. Audited. */
  cancelJob(jobId: string, principal: FilePrincipal): VideoProcessingJob {
    const rec = this.jobs.get(jobId);
    if (!rec) throw new VideoIntelligenceError('VIDEO_JOB_NOT_FOUND', 'Video job was not found.');
    if (!this.jobAllowed(rec.job, principal))
      throw new VideoIntelligenceError('VIDEO_UNAUTHORIZED', 'Video job access was denied.');
    if (TERMINAL.includes(rec.job.status)) return rec.job;
    rec.cancelled = true;
    rec.job = {
      ...rec.job,
      status: 'cancelled',
      stage: 'done',
      updatedAt: this.now().toISOString(),
    };
    this.audit('video_job_cancelled', principal.ownerRef, { jobId });
    return rec.job;
  }

  /** Stored description + transcript + scenes + OCR for a processed video. */
  async analysis(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoAnalysisRecord> {
    await this.requireVideo(fileId, principal);
    const rec = this.records.get(String(fileId));
    if (!rec || (!rec.description && !rec.transcript && !rec.scenes && !rec.ocr))
      throw new VideoIntelligenceError('VIDEO_NOT_PROCESSED');
    return {
      description: rec.description,
      transcript: rec.transcript,
      scenes: rec.scenes,
      ocr: rec.ocr,
      jobId: (rec.jobId ?? null) as never,
    };
  }

  /** Controlled frame extraction. Hard limits on every request; frames are
   *  provider-described descriptors, never unlimited pixel dumps. */
  async frames(
    fileId: FileAssetId,
    options: FrameRequestOptions,
    principal: FilePrincipal,
  ): Promise<VideoFrameExtraction> {
    const { bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const strategy: FrameStrategy =
      options.strategy && (FRAME_STRATEGIES as readonly string[]).includes(options.strategy)
        ? options.strategy
        : 'even';
    if (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 1))
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST');
    if ((options.timestamps?.length ?? 0) > this.limits.maxTimestampRequests)
      throw new VideoIntelligenceError('VIDEO_LIMIT_EXCEEDED');
    const count = Math.max(1, Math.min(options.count ?? 6, this.limits.maxFramesPerRequest));
    const rec = this.record(String(fileId));
    if (rec.framesExtracted + count > this.limits.maxFramesPerVideo)
      throw new VideoIntelligenceError(
        'VIDEO_LIMIT_EXCEEDED',
        'Frame extraction budget for this video is exhausted.',
        { extracted: rec.framesExtracted, limit: this.limits.maxFramesPerVideo },
      );
    const timestamps = (options.timestamps ?? [])
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0)
      .slice(0, this.limits.maxTimestampRequests);
    const provider = this.providerFor('frame_analysis');
    const parsed = parseFrames(
      await this.callProvider(
        provider,
        {
          op: 'frames',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          strategy,
          count,
          atSeconds: options.atSeconds,
          timestamps,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      (await this.files.getFile(fileId, principal)).metadata.checksum,
      strategy,
      container.durationSeconds,
      count,
    );
    rec.frames = [...rec.frames, ...parsed.frames].slice(-this.limits.maxFramesPerVideo);
    this.audit('video_frames_extracted', principal.ownerRef, {
      fileId: String(fileId),
      strategy,
      frameCount: parsed.frames.length,
    });
    return {
      fileId,
      strategy,
      frames: parsed.frames,
      pixelDataAvailable: false,
      truncated: parsed.truncated,
      providerId: provider.id,
    };
  }

  /** Bounded scene detection. Observed transitions stay separate from
   *  inferred content descriptions. */
  async scenes(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoSceneAnalysis> {
    const { file, bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('scene_detection');
    const analysis = this.record(String(fileId));
    const parsed = parseScenes(
      await this.callProvider(
        provider,
        {
          op: 'scenes',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
      container.durationSeconds,
      analysis.frames.map((f) => f.id),
      64,
    );
    const result: VideoSceneAnalysis = {
      fileId,
      scenes: parsed.scenes,
      truncated: parsed.truncated,
      providerId: provider.id,
      trust: 'ai_generated',
    };
    analysis.scenes = result;
    this.audit('video_scenes_detected', principal.ownerRef, {
      fileId: String(fileId),
      sceneCount: parsed.scenes.length,
    });
    return result;
  }

  /** Speech-to-text over the audio track. Transcripts are UNTRUSTED DATA. */
  async transcript(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoTranscript> {
    const { file, bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('transcription');
    const analysis = this.record(String(fileId));
    const parsed = parseTranscript(
      await this.callProvider(
        provider,
        {
          op: 'transcript',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
      container.durationSeconds,
      2000,
      this.limits.maxTranscriptCharacters,
    );
    analysis.transcript = parsed.transcript;
    this.audit('video_transcribed', principal.ownerRef, {
      fileId: String(fileId),
      segmentCount: parsed.transcript.segments.length,
    });
    return parsed.transcript;
  }

  /** Temporal Q&A. Evidence keeps visual and audio provenance separate;
   *  combined statements are labeled inference. */
  async ask(
    fileId: FileAssetId,
    question: string,
    principal: FilePrincipal,
  ): Promise<VideoQueryResult> {
    const q = question.trim();
    if (!q) throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'A question is required.');
    const { bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('video_question_answering');
    const analysis = this.record(String(fileId));
    const result = parseQueryResult(
      await this.callProvider(
        provider,
        {
          op: 'ask',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          question: q,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      q,
      container.durationSeconds,
      analysis.frames.map((f) => f.id),
      analysis.scenes?.scenes.map((s) => s.id) ?? [],
      analysis.transcript?.segments.map((s) => s.id) ?? [],
    );
    this.audit('video_queried', principal.ownerRef, { fileId: String(fileId) });
    return result;
  }

  /** Timeline of temporal events, classified observed / inferred /
   *  uncertain. Ordering is by timestamp; unknown times go last and are
   *  never fabricated. */
  async timeline(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoTimeline> {
    const { file, bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('temporal_reasoning');
    const analysis = this.record(String(fileId));
    const parsed = parseTimeline(
      await this.callProvider(
        provider,
        {
          op: 'timeline',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
      container.durationSeconds,
      analysis.frames.map((f) => f.id),
      analysis.scenes?.scenes.map((s) => s.id) ?? [],
      analysis.transcript?.segments.map((s) => s.id) ?? [],
      200,
    );
    analysis.timeline = parsed.timeline;
    this.audit('video_timeline_built', principal.ownerRef, {
      fileId: String(fileId),
      eventCount: parsed.timeline.events.length,
    });
    return parsed.timeline;
  }

  /** OCR across analyzed frames. Visible text is UNTRUSTED DATA. */
  async ocr(fileId: FileAssetId, principal: FilePrincipal): Promise<VideoOcrResult> {
    const { file, bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('ocr');
    const analysis = this.record(String(fileId));
    const parsed = parseOcrResult(
      await this.callProvider(
        provider,
        {
          op: 'ocr',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      file.metadata.checksum,
      this.now().toISOString(),
      container.durationSeconds,
      analysis.frames.map((f) => f.id),
      200,
      this.limits.maxOcrCharacters,
    );
    analysis.ocr = parsed.ocr;
    this.audit('video_ocr_completed', principal.ownerRef, {
      fileId: String(fileId),
      entryCount: parsed.ocr.entries.length,
    });
    return parsed.ocr;
  }

  /** Summaries by mode. Action items and decisions are suggestions. */
  async summarize(
    fileId: FileAssetId,
    mode: VideoSummaryMode,
    principal: FilePrincipal,
  ): Promise<VideoSummary> {
    const { bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('summarization');
    const analysis = this.record(String(fileId));
    const summary = parseSummary(
      await this.callProvider(
        provider,
        {
          op: 'summarize',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          mode,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      mode,
      container.durationSeconds,
    );
    analysis.summary = summary;
    this.audit('video_summarized', principal.ownerRef, {
      fileId: String(fileId),
      mode,
    });
    return summary;
  }

  /** Structured field extraction over the video's modalities. */
  async extract(
    fileId: FileAssetId,
    fields: readonly string[],
    principal: FilePrincipal,
  ): Promise<VideoExtraction> {
    const wanted = fields.filter((f) => typeof f === 'string' && f.trim()).slice(0, 20);
    const { bytes, mimeType, format, container } = await this.requireVideo(fileId, principal);
    const provider = this.providerFor('structured_extraction');
    const analysis = this.record(String(fileId));
    const extraction = parseExtraction(
      await this.callProvider(
        provider,
        {
          op: 'extract',
          video: this.attachment(bytes, mimeType),
          media: {
            format,
            durationSeconds: container.durationSeconds,
            width: container.width,
            height: container.height,
          },
          fields: wanted,
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
    );
    analysis.extraction = extraction;
    this.audit('video_extraction_run', principal.ownerRef, { fileId: String(fileId) });
    return extraction;
  }

  /** Transcript translation. The original transcript is never replaced. */
  async translate(
    fileId: FileAssetId,
    language: string,
    principal: FilePrincipal,
  ): Promise<VideoTranslation> {
    const lang = language.trim();
    if (!lang || lang.length > 20)
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'A language code is required.');
    const analysis = this.record(String(fileId));
    if (!analysis.transcript)
      throw new VideoIntelligenceError(
        'VIDEO_NOT_PROCESSED',
        'Transcribe the video before translating it.',
      );
    await this.requireVideo(fileId, principal);
    const provider = this.providerFor('translation');
    const translation = parseTranslation(
      await this.callProvider(
        provider,
        {
          op: 'translate',
          video: {
            base64Data: Buffer.from(new Uint8Array(0)).toString('base64'),
            mimeType: 'video/mp4',
          },
          media: { format: null, durationSeconds: null, width: null, height: null },
          language: lang,
          transcriptSegments: analysis.transcript.segments.map((s) => s.text),
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileId,
      lang,
      analysis.transcript.segments.length,
    );
    analysis.translation = translation;
    this.audit('video_translated', principal.ownerRef, { fileId: String(fileId), language: lang });
    return translation;
  }

  /** Comparison of two authorized videos. No semantic equivalence claimed. */
  async compare(
    fileAId: FileAssetId,
    fileBId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<VideoComparisonResult> {
    const a = await this.requireVideo(fileAId, principal);
    const b = await this.requireVideo(fileBId, principal);
    if (String(fileAId) === String(fileBId))
      throw new VideoIntelligenceError(
        'VIDEO_INVALID_REQUEST',
        'Comparing a video with itself is not meaningful.',
      );
    const provider = this.providerFor('video_understanding');
    const result = parseComparisonResult(
      await this.callProvider(
        provider,
        {
          op: 'compare',
          video: this.attachment(a.bytes, a.mimeType),
          other: this.attachment(b.bytes, b.mimeType),
          media: {
            format: a.format,
            durationSeconds: a.container.durationSeconds,
            width: a.container.width,
            height: a.container.height,
          },
          isCancelled: () => false,
        },
        null,
        this.now().getTime() + this.limits.maxProcessingMs,
      ),
      provider.id,
      fileAId,
      fileBId,
      a.container.durationSeconds,
      b.container.durationSeconds,
    );
    this.record(String(fileAId)).comparison = result;
    this.audit('video_compared', principal.ownerRef, {
      fileAId: String(fileAId),
      fileBId: String(fileBId),
    });
    return result;
  }

  /** Deterministic search within one video's stored (untrusted) content. */
  async searchVideo(
    fileId: FileAssetId,
    query: string,
    principal: FilePrincipal,
  ): Promise<VideoSearchResult> {
    await this.requireVideo(fileId, principal);
    const q = query.trim().toLowerCase();
    if (!q)
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'A search query is required.');
    const rec = this.records.get(String(fileId));
    const matches: VideoSearchMatch[] = [];
    const hit = (
      reason: VideoSearchMatch['reason'],
      matchedText: string,
      at: number | null,
      refId: string | null,
    ) => {
      matches.push({
        fileId,
        reason,
        matchedText: matchedText.slice(0, 200),
        timestampSeconds: at,
        refId,
      });
    };
    if (rec) {
      for (const segment of rec.transcript?.segments ?? [])
        if (segment.text.toLowerCase().includes(q))
          hit('spoken', segment.text, segment.startSeconds, segment.id);
      for (const entry of rec.ocr?.entries ?? [])
        if (entry.text.toLowerCase().includes(q))
          hit('visible_text', entry.text, entry.timestampSeconds, entry.id);
      for (const scene of rec.scenes?.scenes ?? []) {
        for (const o of scene.observed)
          if (o.toLowerCase().includes(q)) hit('scene', o, scene.startSeconds, scene.id);
        for (const i of scene.inferred)
          if (i.toLowerCase().includes(q)) hit('scene', i, scene.startSeconds, scene.id);
      }
      for (const event of rec.timeline?.events ?? [])
        if (event.statement.toLowerCase().includes(q))
          hit('event', event.statement, event.timestampSeconds, event.id);
    }
    const capped = matches.slice(0, this.limits.maxSearchMatches);
    this.audit('video_search_performed', principal.ownerRef, { matchCount: capped.length });
    return {
      query: q,
      matches: capped,
      truncated: matches.length > capped.length,
      trust: 'untrusted_data',
    };
  }

  /** Deterministic search across a principal's processed videos (bounded). */
  async searchVideos(
    query: string,
    principal: FilePrincipal,
    filter: { projectId?: string | null } = {},
  ): Promise<VideoSearchResult> {
    const q = query.trim().toLowerCase();
    if (!q)
      throw new VideoIntelligenceError('VIDEO_INVALID_REQUEST', 'A search query is required.');
    const matches: VideoSearchMatch[] = [];
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
      const hay: Array<[VideoSearchMatch['reason'], string, number | null, string | null]> = [];
      for (const segment of rec.transcript?.segments ?? [])
        hay.push(['spoken', segment.text, segment.startSeconds, segment.id]);
      for (const entry of rec.ocr?.entries ?? [])
        hay.push(['visible_text', entry.text, entry.timestampSeconds, entry.id]);
      for (const event of rec.timeline?.events ?? [])
        hay.push(['event', event.statement, event.timestampSeconds, event.id]);
      const found = hay.find(([_, text]) => text.toLowerCase().includes(q));
      if (found)
        matches.push({
          fileId: file.id,
          reason: found[0],
          matchedText: found[1].slice(0, 200),
          timestampSeconds: found[2],
          refId: found[3],
        });
    }
    this.audit('video_search_performed', principal.ownerRef, { matchCount: matches.length });
    return { query: q, matches, truncated, trust: 'untrusted_data' };
  }

  /** Persist a derived artifact through the Step 19 file system. */
  async saveArtifact(
    fileId: FileAssetId,
    principal: FilePrincipal,
    draft: { kind: VideoArtifactKind },
  ): Promise<VideoArtifactView> {
    const { file } = await this.requireVideo(fileId, principal);
    const rec = this.records.get(String(fileId));
    const base = file.metadata.normalizedFilename.replace(/\.[^.]+$/, '');
    const needs = (present: boolean) => {
      if (!present) throw new VideoIntelligenceError('VIDEO_NOT_PROCESSED');
    };
    const buffer = (text: string) => Buffer.from(text, 'utf8');
    let filename: string;
    let mimeType: string;
    let bytes: Buffer;
    switch (draft.kind) {
      case 'video_metadata_json': {
        filename = `${base}-metadata.json`;
        mimeType = 'application/json';
        bytes = buffer(
          JSON.stringify(
            {
              filename: file.metadata.normalizedFilename,
              byteSize: file.metadata.byteSize,
              checksum: file.metadata.checksum,
              container: rec ? undefined : undefined,
              note: 'Container facts are available via the metadata endpoint.',
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'transcript_txt': {
        needs(!!rec?.transcript);
        filename = `${base}-transcript.txt`;
        mimeType = 'text/plain';
        bytes = buffer(
          `# Untrusted transcript data from ${file.metadata.normalizedFilename}\n\n${rec!.transcript!.text}`,
        );
        break;
      }
      case 'transcript_json': {
        needs(!!rec?.transcript);
        filename = `${base}-transcript.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.transcript!, null, 2));
        break;
      }
      case 'video_summary_md': {
        needs(!!rec?.summary);
        filename = `${base}-summary.md`;
        mimeType = 'text/markdown';
        const s = rec!.summary!;
        bytes = buffer(
          `# Video summary (${s.mode}): ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated interpretation. Not a direct video fact.\n\n${s.summary}\n\n` +
            (s.keyPoints.length
              ? `## Key points\n${s.keyPoints.map((k) => `- ${k}`).join('\n')}\n`
              : '') +
            (s.decisions.length
              ? `## Decisions (suggestions)\n${s.decisions.map((k) => `- ${k}`).join('\n')}\n`
              : '') +
            (s.actionItems.length
              ? `## Action items (suggestions, never executed)\n${s.actionItems.map((k) => `- ${k.description}`).join('\n')}\n`
              : '') +
            (s.questions.length
              ? `## Questions\n${s.questions.map((k) => `- ${k}`).join('\n')}\n`
              : ''),
        );
        break;
      }
      case 'timeline_md': {
        needs(!!rec?.timeline);
        filename = `${base}-timeline.md`;
        mimeType = 'text/markdown';
        const t = rec!.timeline!;
        bytes = buffer(
          `# Timeline: ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated temporal interpretation. Observed, inferred, and uncertain events are labeled.\n\n` +
            t.events
              .map(
                (e) =>
                  `- [${e.kind}] ${e.timestampSeconds !== null ? `${e.timestampSeconds}s` : 'unknown time'} - ${e.statement}`,
              )
              .join('\n'),
        );
        break;
      }
      case 'timeline_json': {
        needs(!!rec?.timeline);
        filename = `${base}-timeline.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.timeline!, null, 2));
        break;
      }
      case 'scene_analysis_json': {
        needs(!!rec?.scenes);
        filename = `${base}-scenes.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.scenes!, null, 2));
        break;
      }
      case 'ocr_json': {
        needs(!!rec?.ocr);
        filename = `${base}-ocr.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.ocr!, null, 2));
        break;
      }
      case 'meeting_notes_md': {
        needs(!!rec?.summary);
        filename = `${base}-meeting-notes.md`;
        mimeType = 'text/markdown';
        const s = rec!.summary!;
        bytes = buffer(
          `# Meeting notes: ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated interpretation. Decisions and action items are suggestions pending human approval.\n\n${s.summary}\n\n` +
            (s.decisions.length
              ? `## Topics and decisions\n${s.decisions.map((d) => `- ${d}`).join('\n')}\n`
              : '') +
            (s.actionItems.length
              ? `## Action items\n${s.actionItems.map((a) => `- ${a.description}`).join('\n')}\n`
              : '') +
            (s.questions.length
              ? `## Open questions\n${s.questions.map((qq) => `- ${qq}`).join('\n')}\n`
              : ''),
        );
        break;
      }
      case 'action_items_json': {
        needs(!!rec?.summary);
        filename = `${base}-action-items.json`;
        mimeType = 'application/json';
        const s = rec!.summary!;
        bytes = buffer(
          JSON.stringify(
            {
              note: 'Suggestions only. Nothing here is executed automatically.',
              actionItems: s.actionItems,
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'translated_transcript_md': {
        needs(!!rec?.translation);
        filename = `${base}-translated-transcript.md`;
        mimeType = 'text/markdown';
        const t = rec!.translation!;
        bytes = buffer(
          `# Translated transcript (${t.language}): ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated translation. The original transcript is preserved separately and never replaced.\n\n${t.translatedText}`,
        );
        break;
      }
      case 'video_comparison_json': {
        needs(!!rec?.comparison);
        filename = `${base}-comparison.json`;
        mimeType = 'application/json';
        bytes = buffer(JSON.stringify(rec!.comparison!, null, 2));
        break;
      }
      case 'bug_analysis_md': {
        needs(!!rec?.summary);
        filename = `${base}-bug-analysis.md`;
        mimeType = 'text/markdown';
        const s = rec!.summary!;
        bytes = buffer(
          `# Bug analysis: ${file.metadata.normalizedFilename}\n\n` +
            `> AI-generated interpretation from visible evidence. Suspected cause is a hypothesis for investigation, not a confirmed implementation fact. Code changes require the Coding Agent with its own approvals.\n\n` +
            `${s.summary}\n\n` +
            (s.observedFailure ? `## Observed failure\n${s.observedFailure}\n` : '') +
            (s.suspectedCause ? `## Suspected cause (hypothesis)\n${s.suspectedCause}\n` : '') +
            (s.steps.length
              ? `## Reproduction sequence\n${s.steps
                  .map(
                    (st, i) =>
                      `${i + 1}. ${st.timestampSeconds !== null ? `[${st.timestampSeconds}s] ` : ''}${st.text}`,
                  )
                  .join('\n')}\n`
              : ''),
        );
        break;
      }
      default:
        throw new VideoIntelligenceError('VIDEO_ARTIFACT_INVALID', 'Unknown artifact kind.');
    }
    const saved = await this.files.registerFile({
      filename,
      bytes,
      declaredMimeType: mimeType,
      source: 'derived_extraction',
      scope: file.scope,
      parentFileId: fileId,
    });
    this.audit('video_artifact_saved', principal.ownerRef, {
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

  /** Authorized video bytes for playback. Integrity-checked on every read. */
  async mediaBytes(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    try {
      const fetched = await this.files.videoBytes(fileId, principal);
      return { bytes: fetched.bytes, mimeType: fetched.mimeType };
    } catch (error) {
      this.mapFileError(error);
    }
  }

  /** Declared capability surface - honest, including simulation status. */
  capabilities(): {
    providers: readonly VideoProviderCapabilities[];
    operations: readonly string[];
    limits: VideoLimits;
  } {
    return {
      providers: this.providers.list().map((p) => p.getCapabilities()),
      operations: [...VIDEO_PROVIDER_OPERATIONS],
      limits: this.limits,
    };
  }

  /** Frames stored so far for a video (evidence lookup). */
  async storedFrames(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<readonly VideoFrame[]> {
    await this.requireVideo(fileId, principal);
    return this.records.get(String(fileId))?.frames ?? noFrames;
  }

  /** Scenes stored so far for a video (evidence lookup). */
  async storedScenes(
    fileId: FileAssetId,
    principal: FilePrincipal,
  ): Promise<readonly VideoScene[]> {
    await this.requireVideo(fileId, principal);
    return this.records.get(String(fileId))?.scenes?.scenes ?? [];
  }
}

export { isFileIntelligenceError, parseProviderJson };

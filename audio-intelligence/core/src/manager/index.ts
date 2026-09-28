/**
 * AudioIntelligenceManager - bounded, auditable audio understanding on top of
 * the Step 19 File Intelligence system.
 *
 * Security invariants:
 * - Audio is UNTRUSTED DATA. Transcripts are untrusted data. Reasoning
 *   output is ai_generated. Nothing here executes tools, mutates projects,
 *   or treats spoken content as authorization.
 * - Every read re-authorizes through FileIntelligenceManager (scope, expiry,
 *   integrity) - the audio layer adds no second trust path.
 * - All processing is bounded: bytes, duration, chunks, transcript size,
 *   context size, concurrent jobs, wall-clock time.
 * - Cancellation is one-way and audited; jobs expire.
 * - Audit metadata never contains transcript content.
 */
import {
  isFileIntelligenceError,
  type Artifact,
  type FileAsset,
  type FileAssetId,
  type FileIntelligenceManager,
  type FileScope,
} from '@veltravia/file-intelligence-core';
import { AudioIntelligenceError } from '../errors/index.js';
import { resolveAudioLimits } from '../limits/index.js';
import { buildAudioAuditEvent, type AudioAuditEvent, type AudioAuditSink } from '../audit/index.js';
import {
  formatFromMime,
  newAudioJobId,
  normalizeLanguageTag,
  parseWavInfo,
  planChunks,
  segmentId,
  truncateText,
} from '../security/index.js';
import {
  parseExtraction,
  parseQueryAnswer,
  parseSummary,
  parseTranslation,
} from '../reasoning/index.js';
import { type AudioProvider } from '../provider/index.js';
import {
  type AudioAnalysis,
  type AudioArtifactKind,
  type AudioJobId,
  type AudioLimits,
  type AudioMetadata,
  type AudioProcessingJob,
  type AudioProcessingStatus,
  type AudioPrincipal,
  type AudioQueryResult,
  type AudioSearchMatch,
  type AudioSearchResult,
  type AudioSummary,
  type AudioSummaryStyle,
  type AudioTranslation,
  type Transcript,
  type TranscriptSegment,
} from '../types/index.js';

export interface AudioIntelligenceOptions {
  /** Step 19 manager: bytes, metadata, artifacts, scope authorization. */
  readonly files: FileIntelligenceManager;
  /** Deterministic mock (default deployments) or a real adapter. */
  readonly provider: AudioProvider;
  readonly limits?: Partial<AudioLimits>;
  readonly now?: () => Date;
  readonly onAudit?: AudioAuditSink;
}

interface JobRecord {
  job: AudioProcessingJob;
  cancelled: boolean;
}
const TERMINAL: readonly AudioProcessingStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
const TRANSITIONS: Record<AudioProcessingStatus, readonly AudioProcessingStatus[]> = {
  received: ['validating', 'cancelled'],
  validating: ['validated', 'failed', 'cancelled'],
  validated: ['processing', 'cancelled'],
  processing: ['transcribing', 'failed', 'cancelled'],
  transcribing: ['analyzing', 'failed', 'cancelled'],
  analyzing: ['completed', 'failed', 'cancelled'],
  completed: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
};

interface ArtifactBuildContext {
  readonly base: string;
  readonly filename: string;
  readonly transcript: Transcript;
  readonly transcriptView: unknown;
  readonly summary: AudioSummary | null;
  readonly analysis: AudioAnalysis | null;
  readonly translation: AudioTranslation | null;
  readonly time: (s: number | null) => string;
  readonly buffer: (text: string) => Uint8Array;
}
const ARTIFACT_SPECS: Record<
  AudioArtifactKind,
  (c: ArtifactBuildContext) => {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    type: string;
  }
> = {
  transcript_txt: (c) => ({
    filename: `${c.base}.transcript.txt`,
    mimeType: 'text/plain',
    type: 'derived_text',
    bytes: c.buffer(c.transcript.text),
  }),
  transcript_md: (c) => ({
    filename: `${c.base}.transcript.md`,
    mimeType: 'text/markdown',
    type: 'derived_text',
    bytes: c.buffer(
      `# Transcript: ${c.filename}\n\n> Untrusted data transcribed from audio. Timestamps are provider-reported.\n\n` +
        c.transcript.segments
          .map(
            (s) =>
              `- **${s.speaker ?? 'Unknown speaker'}** (${c.time(s.startSeconds)}–${c.time(s.endSeconds)}): ${s.text}`,
          )
          .join('\n'),
    ),
  }),
  transcript_json: (c) => ({
    filename: `${c.base}.transcript.json`,
    mimeType: 'application/json',
    type: 'generated_json',
    bytes: c.buffer(JSON.stringify(c.transcriptView, null, 2)),
  }),
  summary_md: (c) => ({
    filename: `${c.base}.summary.md`,
    mimeType: 'text/markdown',
    type: 'report',
    bytes: c.buffer(
      c.summary
        ? `# Summary: ${c.filename}\n\n> AI-generated interpretation. Not a direct audio fact.\n\n${c.summary.text}\n\n` +
            (c.summary.keyPoints.length
              ? `## Key points\n${c.summary.keyPoints.map((k) => `- ${k}`).join('\n')}\n`
              : '')
        : 'No summary available.',
    ),
  }),
  action_items_json: (c) => ({
    filename: `${c.base}.action-items.json`,
    mimeType: 'application/json',
    type: 'generated_json',
    bytes: c.buffer(JSON.stringify(c.analysis?.actionItems ?? [], null, 2)),
  }),
  meeting_notes_md: (c) => ({
    filename: `${c.base}.meeting-notes.md`,
    mimeType: 'text/markdown',
    type: 'report',
    bytes: c.buffer(
      `# Meeting notes: ${c.filename}\n\n> AI-generated interpretation. Not a direct audio fact.\n\n` +
        (c.summary ? `${c.summary.text}\n\n` : '') +
        (c.analysis?.decisions.length
          ? `## Decisions\n${c.analysis.decisions.map((d) => `- ${d.statement} (${d.certainty})`).join('\n')}\n\n`
          : '') +
        (c.analysis?.actionItems.length
          ? `## Action items\n${c.analysis.actionItems
              .map(
                (a) =>
                  `- ${a.description}${a.assignedTo ? ` — ${a.assignedTo}` : ''}${a.deadline ? ` (by ${a.deadline})` : ''}`,
              )
              .join('\n')}\n`
          : ''),
    ),
  }),
  translation_md: (c) => ({
    filename: `${c.base}.translation.md`,
    mimeType: 'text/markdown',
    type: 'derived_text',
    bytes: c.buffer(
      c.translation
        ? `# Translation (${c.translation.targetLanguage}): ${c.filename}\n\n> AI-generated translation; the original transcript is preserved separately.\n\n${c.translation.translatedText}`
        : 'No translation available.',
    ),
  }),
  analysis_json: (c) => ({
    filename: `${c.base}.analysis.json`,
    mimeType: 'application/json',
    type: 'generated_json',
    bytes: c.buffer(JSON.stringify(c.analysis ?? {}, null, 2)),
  }),
};

export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ''}${h > 0 ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}`;
}

/** Bounded retrieval: score segments by term overlap, cap by count+characters. */
function retrieveSegments(
  segments: readonly TranscriptSegment[],
  question: string,
  maxCount: number,
  maxCharacters: number,
): readonly TranscriptSegment[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const scored = segments
    .map((segment, index) => {
      const lower = segment.text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      return { segment, index, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxCount);
  const out: TranscriptSegment[] = [];
  let chars = 0;
  for (const s of scored) {
    if (chars + s.segment.text.length > maxCharacters) break;
    out.push(s.segment);
    chars += s.segment.text.length;
  }
  return out.sort((a, b) => segments.indexOf(a) - segments.indexOf(b));
}

export class AudioIntelligenceManager {
  readonly limits: AudioLimits;
  private readonly files: FileIntelligenceManager;
  private readonly provider: AudioProvider;
  private readonly now: () => Date;
  private readonly onAudit?: AudioAuditSink;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly transcripts = new Map<string, Transcript>();
  private readonly latestSummary = new Map<string, AudioSummary>();
  private readonly latestAnalysis = new Map<string, AudioAnalysis>();

  constructor(options: AudioIntelligenceOptions) {
    this.files = options.files;
    this.provider = options.provider;
    this.limits = resolveAudioLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
  }

  private audit(
    type: AudioAuditEvent['type'],
    scope: FileScope,
    fileId: string | null,
    jobId: string | null,
    metadata: Record<string, string | number | boolean | null> = {},
  ) {
    this.onAudit?.(
      buildAudioAuditEvent(type, this.now().toISOString(), scope, fileId, jobId, metadata),
    );
  }

  /** True when the configured provider is a simulation (for honest UI labels). */
  get providerIsSimulation(): boolean {
    return (
      this.provider.id.startsWith('mock') ||
      (this.provider as { isSimulation?: boolean }).isSimulation === true
    );
  }
  providerCapabilities() {
    return this.provider.capabilities();
  }

  private async requireAudio(
    fileId: FileAssetId,
    principal: AudioPrincipal,
  ): Promise<{ file: FileAsset; transcript: Transcript }> {
    const file = await this.files.getFile(fileId, principal); // re-authorizes scope + expiry
    if (file.metadata.category !== 'audio')
      throw new AudioIntelligenceError('AUDIO_UNSUPPORTED_FORMAT', 'File is not audio.');
    const transcript = this.transcripts.get(fileId);
    if (!transcript)
      throw new AudioIntelligenceError(
        'AUDIO_NOT_PROCESSED',
        'No transcript exists for this file yet.',
      );
    return { file, transcript };
  }

  async inspect(fileId: FileAssetId, principal: AudioPrincipal): Promise<AudioMetadata> {
    const file = await this.files.getFile(fileId, principal);
    if (file.metadata.category !== 'audio')
      throw new AudioIntelligenceError('AUDIO_UNSUPPORTED_FORMAT', 'File is not audio.');
    const bytes = await this.files.audioBytes(fileId, principal);
    const wav = /wav/i.test(file.metadata.detectedMimeType ?? '')
      ? parseWavInfo(bytes.bytes)
      : null;
    return {
      fileId: file.id,
      filename: file.metadata.normalizedFilename,
      mimeType: file.metadata.detectedMimeType ?? 'application/octet-stream',
      format: formatFromMime(file.metadata.detectedMimeType ?? ''),
      byteSize: file.metadata.byteSize,
      checksum: file.metadata.checksum,
      durationSeconds: file.metadata.durationSeconds,
      sampleRateHz: wav?.sampleRateHz ?? null,
      channels: wav?.channels ?? null,
      codec: wav ? 'pcm' : null,
      createdAt: file.createdAt,
      scope: file.scope,
    };
  }

  private transcriptView(t: Transcript) {
    return {
      fileId: t.fileId,
      language: t.language,
      languageAutoDetected: t.languageAutoDetected,
      provider: t.providerId,
      timestampsAvailable: t.timestampsAvailable,
      speakersAvailable: t.speakersAvailable,
      confidence: t.confidence,
      chunkCount: t.chunkCount,
      segments: t.segments.map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        speaker: s.speaker,
        confidence: s.confidence,
        text: s.text,
      })),
      text: t.text,
      trust: t.trust,
    };
  }

  /** Authorized, integrity-checked audio bytes for playback (media route). */
  async mediaBytes(
    fileId: FileAssetId,
    principal: AudioPrincipal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const file = await this.files.getFile(fileId, principal);
    if (file.metadata.category !== 'audio')
      throw new AudioIntelligenceError('AUDIO_UNSUPPORTED_FORMAT', 'File is not audio.');
    return this.files.audioBytes(fileId, principal);
  }

  async process(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    options: { language?: string | null } = {},
  ): Promise<AudioProcessingJob> {
    const requested = normalizeLanguageTag(options.language ?? null);
    const file = await this.files.getFile(fileId, principal);
    if (file.metadata.category !== 'audio')
      throw new AudioIntelligenceError('AUDIO_UNSUPPORTED_FORMAT', 'File is not audio.');
    if (file.metadata.byteSize > this.limits.maxFileBytes)
      throw new AudioIntelligenceError(
        'AUDIO_LIMIT_EXCEEDED',
        'Audio file exceeds the size limit.',
        {
          bytes: file.metadata.byteSize,
          limit: this.limits.maxFileBytes,
        },
      );
    if (
      file.metadata.durationSeconds !== null &&
      file.metadata.durationSeconds > this.limits.maxDurationSeconds
    )
      throw new AudioIntelligenceError(
        'AUDIO_LIMIT_EXCEEDED',
        'Audio duration exceeds the limit.',
        {
          seconds: Math.round(file.metadata.durationSeconds),
          limit: this.limits.maxDurationSeconds,
        },
      );
    const active = [...this.jobs.values()].filter((r) => !TERMINAL.includes(r.job.status));
    if (active.length >= this.limits.maxConcurrentJobs)
      throw new AudioIntelligenceError('AUDIO_LIMIT_EXCEEDED', 'Too many active audio jobs.', {
        active: active.length,
        limit: this.limits.maxConcurrentJobs,
      });
    if (!this.provider.capabilities().capabilities.includes('transcription'))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider cannot transcribe audio.',
      );
    const format = formatFromMime(file.metadata.detectedMimeType ?? '');
    const acceptedFormats = this.provider.capabilities().supportedFormats;
    if (acceptedFormats && format && !acceptedFormats.includes(format))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider does not accept this format.',
      );

    const now = this.now().toISOString();
    const id = newAudioJobId();
    const rec: JobRecord = {
      job: {
        id: id as AudioJobId,
        fileId,
        ownerRef: principal.ownerRef,
        projectId: file.scope.projectId,
        workspaceId: file.scope.workspaceId,
        status: 'received',
        stage: 'queued',
        requestedLanguage: requested,
        detectedLanguage: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(this.now().getTime() + this.limits.jobTtlSeconds * 1000).toISOString(),
        chunks: 0,
        completedChunks: 0,
        error: null,
      },
      cancelled: false,
    };
    this.jobs.set(id, rec);
    const step = async (status: AudioProcessingStatus, stage: AudioProcessingJob['stage']) => {
      if (!TRANSITIONS[rec.job.status].includes(status))
        throw new AudioIntelligenceError(
          'AUDIO_INVALID_TRANSITION',
          `Cannot move job from ${rec.job.status} to ${status}.`,
        );
      rec.job = { ...rec.job, status, stage, updatedAt: this.now().toISOString() };
    };
    this.audit('audio_processing_started', file.scope, fileId, id, { format: format ?? 'unknown' });
    const deadline = this.now().getTime() + this.limits.maxProcessingMs;
    try {
      await step('validating', 'validation');
      const bytes = await this.files.audioBytes(fileId, principal);
      const plan = planChunks(bytes.bytes.length, this.limits.maxChunks, this.limits.maxFileBytes);
      if (plan.count > 1 && !this.provider.capabilities().capabilities.includes('long_audio'))
        throw new AudioIntelligenceError(
          'AUDIO_CAPABILITY_UNSUPPORTED',
          'Provider cannot process long audio.',
        );
      await step('validated', 'chunking');
      rec.job = { ...rec.job, chunks: plan.count };
      await step('processing', 'chunking');
      await step('transcribing', 'transcription');
      const wav = format === 'wav' ? parseWavInfo(bytes.bytes) : null;
      const collected: TranscriptSegment[] = [];
      let detected: string | null = null;
      let overallConfidence: number | null = null;
      for (let index = 0; index < plan.count; index++) {
        if (rec.cancelled) throw new AudioIntelligenceError('AUDIO_PROCESSING_CANCELLED');
        if (this.now().getTime() > deadline)
          throw new AudioIntelligenceError(
            'AUDIO_PROVIDER_TIMEOUT',
            'Audio processing exceeded the time limit.',
          );
        const from = index * plan.size;
        const slice = bytes.bytes.slice(from, Math.min(bytes.bytes.length, from + plan.size));
        const offset =
          wav?.byteRate && wav.byteRate > 0 && format === 'wav' ? from / wav.byteRate : null;
        const out = await this.provider.transcribe({
          bytes: slice,
          format,
          mimeType: bytes.mimeType,
          index,
          total: plan.count,
          language: requested,
          offsetSeconds: offset,
          isCancelled: () => rec.cancelled,
        });
        if (rec.cancelled) throw new AudioIntelligenceError('AUDIO_PROCESSING_CANCELLED');
        out.segments.forEach((raw, s) => {
          collected.push({
            id: segmentId(id, index * 1000 + s),
            startSeconds: raw.startSeconds,
            endSeconds: raw.endSeconds,
            speaker: raw.speaker,
            text: raw.text,
            confidence: raw.confidence,
          });
        });
        detected = detected ?? out.language ?? null;
        overallConfidence = overallConfidence ?? out.confidence ?? null;
        rec.job = {
          ...rec.job,
          completedChunks: index + 1,
          updatedAt: this.now().toISOString(),
        };
      }
      await step('analyzing', 'assembly');
      const capped = collected.slice(0, 5000);
      const text = truncateText(
        capped.map((c) => c.text).join('\n'),
        this.limits.maxTranscriptCharacters,
      );
      const transcript: Transcript = {
        fileId,
        language: detected,
        languageAutoDetected: requested === null && detected !== null,
        segments: capped,
        text: text.text,
        providerId: this.provider.id,
        timestampsAvailable:
          this.provider.capabilities().capabilities.includes('timestamps') &&
          capped.some((c) => c.startSeconds !== null),
        speakersAvailable:
          this.provider.capabilities().capabilities.includes('speaker_identification') &&
          capped.some((c) => c.speaker !== null),
        confidence: overallConfidence,
        chunkCount: plan.count,
        jobId: id as AudioJobId,
        createdAt: this.now().toISOString(),
        trust: 'untrusted_data',
      };
      this.transcripts.set(fileId, transcript);
      await step('completed', 'done');
      rec.job = {
        ...rec.job,
        detectedLanguage: detected,
        expiresAt: new Date(this.now().getTime() + this.limits.jobTtlSeconds * 1000).toISOString(),
      };
      this.audit('audio_job_completed', file.scope, fileId, id, {
        chunks: plan.count,
        segments: capped.length,
        truncated: text.truncated,
      });
      return rec.job;
    } catch (error) {
      const cancelled =
        error instanceof AudioIntelligenceError && error.code === 'AUDIO_PROCESSING_CANCELLED';
      const code = error instanceof AudioIntelligenceError ? error.code : 'AUDIO_PROVIDER_ERROR';
      rec.job = {
        ...rec.job,
        status: cancelled ? 'cancelled' : 'failed',
        error: {
          code,
          message: error instanceof Error ? error.message : 'Audio processing failed.',
        },
        updatedAt: this.now().toISOString(),
      };
      this.audit(cancelled ? 'audio_job_cancelled' : 'audio_job_failed', file.scope, fileId, id, {
        code,
        chunks: rec.job.completedChunks,
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

  async getJob(jobId: string, principal: AudioPrincipal): Promise<AudioProcessingJob> {
    this.expireJobs();
    const rec = this.jobs.get(jobId);
    if (!rec) throw new AudioIntelligenceError('AUDIO_JOB_NOT_FOUND', 'Audio job was not found.');
    if (rec.job.ownerRef !== principal.ownerRef) {
      this.audit(
        'audio_authorization_denied',
        {
          ownerRef: principal.ownerRef,
          projectId: rec.job.projectId,
          workspaceId: rec.job.workspaceId,
        },
        rec.job.fileId,
        jobId,
        { reason: 'owner' },
      );
      throw new AudioIntelligenceError('AUDIO_UNAUTHORIZED', 'Audio job access was denied.');
    }
    return rec.job;
  }

  async listJobs(
    principal: AudioPrincipal,
    filter: { fileId?: string | null } = {},
  ): Promise<readonly AudioProcessingJob[]> {
    this.expireJobs();
    return [...this.jobs.values()]
      .map((r) => r.job)
      .filter(
        (j) => j.ownerRef === principal.ownerRef && (!filter.fileId || j.fileId === filter.fileId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  /** One-way cancellation; idempotent once terminal. Bounded and audited. */
  async cancelJob(jobId: string, principal: AudioPrincipal): Promise<AudioProcessingJob> {
    const rec = this.jobs.get(jobId);
    if (!rec) throw new AudioIntelligenceError('AUDIO_JOB_NOT_FOUND', 'Audio job was not found.');
    if (rec.job.ownerRef !== principal.ownerRef)
      throw new AudioIntelligenceError('AUDIO_UNAUTHORIZED', 'Audio job access was denied.');
    if (TERMINAL.includes(rec.job.status)) return rec.job;
    rec.cancelled = true;
    return rec.job;
  }

  async getTranscript(fileId: FileAssetId, principal: AudioPrincipal): Promise<unknown> {
    const { transcript } = await this.requireAudio(fileId, principal);
    return this.transcriptView(transcript);
  }

  /** Deterministic, bounded transcript-content search (words/phrases). */
  async search(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    query: string,
  ): Promise<AudioSearchResult> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    const q = query.trim().toLowerCase();
    if (!q) throw new AudioIntelligenceError('AUDIO_INVALID_REQUEST', 'Search query is required.');
    const segments = transcript.segments;
    const hits: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment && segment.text.toLowerCase().includes(q)) hits.push(i);
    }
    const matches: AudioSearchMatch[] = hits.slice(0, this.limits.maxSearchMatches).map((i) => {
      const segment = segments[i];
      const prev = i > 0 ? segments[i - 1] : undefined;
      const next = i + 1 < segments.length ? segments[i + 1] : undefined;
      return {
        segment: segment as TranscriptSegment,
        context: [prev?.text, segment?.text, next?.text].filter(Boolean).join(' … ').slice(0, 2000),
      };
    });
    this.audit('audio_search_performed', file.scope, fileId, null, { matches: matches.length });
    return { fileId, query: q, matches, truncated: hits.length > matches.length };
  }

  /** Bounded retrieval + provider reasoning. Supporting evidence is real segments only. */
  async query(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    question: string,
  ): Promise<AudioQueryResult> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    const q = question.trim();
    if (!q) throw new AudioIntelligenceError('AUDIO_INVALID_REQUEST', 'Question is required.');
    if (!this.provider.capabilities().capabilities.includes('question_answering'))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider cannot answer questions.',
      );
    const retrieved = retrieveSegments(
      transcript.segments,
      q,
      this.limits.maxQuerySupportingSegments,
      this.limits.maxContextCharacters,
    );
    const out = await this.provider.reason({
      op: 'query',
      transcriptText: transcript.text.slice(0, this.limits.maxContextCharacters),
      segments: retrieved.map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        speaker: s.speaker,
        text: s.text,
      })),
      question: q,
      sourceLanguage: transcript.language,
    });
    const parsed = parseQueryAnswer(out.text);
    const byId = new Map(retrieved.map((s) => [s.id, s]));
    const supporting = parsed.supportingSegmentIds
      .map((segId) => byId.get(segId))
      .filter((s): s is TranscriptSegment => s !== undefined);
    this.audit('audio_query_answered', file.scope, fileId, null, { supporting: supporting.length });
    return {
      fileId,
      question: q,
      answer: parsed.answer.slice(0, 8000),
      supportingSegments: supporting,
      providerId: this.provider.id,
      trust: 'ai_generated',
    };
  }

  async summarize(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    style: AudioSummaryStyle = 'short',
  ): Promise<AudioSummary> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    if (!this.provider.capabilities().capabilities.includes('summarization'))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider cannot summarize.',
      );
    const out = await this.provider.reason({
      op: 'summarize',
      transcriptText: transcript.text.slice(0, this.limits.maxContextCharacters),
      segments: transcript.segments.slice(0, 200).map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        speaker: s.speaker,
        text: s.text,
      })),
      style,
      sourceLanguage: transcript.language,
    });
    const summary = parseSummary(out.text, style, this.provider.id, fileId);
    this.latestSummary.set(fileId, summary);
    this.audit('audio_summary_generated', file.scope, fileId, null, { style });
    return summary;
  }

  async extract(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    fields: readonly string[] = [
      'names',
      'organizations',
      'dates',
      'locations',
      'amounts',
      'tasks',
      'decisions',
      'deadlines',
      'questions',
      'issues',
    ],
  ): Promise<AudioAnalysis> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    if (!this.provider.capabilities().capabilities.includes('structured_extraction'))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider cannot extract structure.',
      );
    const out = await this.provider.reason({
      op: 'extract',
      transcriptText: transcript.text.slice(0, this.limits.maxContextCharacters),
      segments: transcript.segments.slice(0, 200).map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        speaker: s.speaker,
        text: s.text,
      })),
      fields: fields.slice(0, 12),
      sourceLanguage: transcript.language,
    });
    const parsed = parseExtraction(out.text);
    const realIds = new Set(transcript.segments.map((s) => s.id));
    const clean = <T extends { evidence: { segmentId: string } | null }>(
      items: readonly T[],
    ): readonly T[] =>
      items.map((i) =>
        i.evidence && !realIds.has(i.evidence.segmentId) ? { ...i, evidence: null } : i,
      );
    const analysis: AudioAnalysis = {
      fileId,
      summary: null,
      actionItems: clean(parsed.actionItems),
      decisions: clean(parsed.decisions),
      entities: clean(parsed.entities),
      trust: 'ai_generated',
    };
    this.latestAnalysis.set(fileId, analysis);
    this.audit('audio_extraction_generated', file.scope, fileId, null, {
      entities: analysis.entities.length,
      actionItems: analysis.actionItems.length,
      decisions: analysis.decisions.length,
    });
    return analysis;
  }

  async translate(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    input: {
      targetLanguage: string;
      scope: 'transcript' | 'segment' | 'summary';
      segmentId?: string | null;
      summaryText?: string | null;
    },
  ): Promise<AudioTranslation> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    if (!this.provider.capabilities().capabilities.includes('translation'))
      throw new AudioIntelligenceError(
        'AUDIO_CAPABILITY_UNSUPPORTED',
        'Provider cannot translate.',
      );
    const target = normalizeLanguageTag(input.targetLanguage);
    if (!target)
      throw new AudioIntelligenceError(
        'AUDIO_INVALID_REQUEST',
        'A valid target language is required.',
      );
    let source: string;
    if (input.scope === 'segment') {
      const segment = transcript.segments.find((s) => s.id === input.segmentId);
      if (!segment)
        throw new AudioIntelligenceError('AUDIO_INVALID_REQUEST', 'Segment was not found.');
      source = segment.text;
    } else if (input.scope === 'summary') {
      if (!input.summaryText)
        throw new AudioIntelligenceError('AUDIO_INVALID_REQUEST', 'Summary text is required.');
      source = input.summaryText;
    } else {
      source = transcript.text;
    }
    const out = await this.provider.reason({
      op: 'translate',
      transcriptText: source.slice(0, this.limits.maxContextCharacters),
      segments: transcript.segments.slice(0, 200).map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        speaker: s.speaker,
        text: s.text,
      })),
      targetLanguage: target,
      sourceLanguage: transcript.language,
    });
    const translation: AudioTranslation = {
      fileId,
      targetLanguage: target,
      scope: input.scope,
      segmentId: input.scope === 'segment' ? (input.segmentId ?? null) : null,
      translatedText: parseTranslation(out.text),
      originalPreserved: true,
      providerId: this.provider.id,
      trust: 'ai_generated',
    };
    this.audit('audio_translation_generated', file.scope, fileId, null, {
      target,
      scope: input.scope,
    });
    return translation;
  }

  /** Analysis = meeting summary + extraction, one honest bundle. */
  async analyze(fileId: FileAssetId, principal: AudioPrincipal): Promise<AudioAnalysis> {
    const summary = await this.summarize(fileId, principal, 'meeting');
    const extraction = await this.extract(fileId, principal);
    const analysis: AudioAnalysis = { ...extraction, summary };
    this.latestAnalysis.set(fileId, analysis);
    return analysis;
  }

  /** Persist a derived artifact through the Step 19 artifact system. */
  async saveArtifact(
    fileId: FileAssetId,
    principal: AudioPrincipal,
    draft: { kind: AudioArtifactKind; filename?: string; translation?: AudioTranslation },
  ): Promise<Artifact> {
    const { file, transcript } = await this.requireAudio(fileId, principal);
    const ctx: ArtifactBuildContext = {
      base: file.metadata.normalizedFilename.replace(/\.[^.]+$/, ''),
      filename: file.metadata.normalizedFilename,
      transcript,
      transcriptView: this.transcriptView(transcript),
      summary: this.latestSummary.get(fileId) ?? null,
      analysis: this.latestAnalysis.get(fileId) ?? null,
      translation: draft.translation ?? null,
      time: (s: number | null) => (s === null ? '--:--' : formatSeconds(s)),
      buffer: (text: string) => Buffer.from(text, 'utf8'),
    };
    const spec = ARTIFACT_SPECS[draft.kind](ctx);
    const artifact = await this.files.createArtifact({
      type: spec.type as never,
      filename: draft.filename ?? spec.filename,
      mimeType: spec.mimeType,
      bytes: spec.bytes,
      scope: file.scope,
      sourceOperation: `audio:${draft.kind}:${fileId}`,
      parentFileIds: [fileId],
    });
    this.audit('audio_artifact_saved', file.scope, fileId, null, {
      kind: draft.kind,
      artifactId: artifact.id,
      bytes: spec.bytes.length,
    });
    return artifact;
  }
}

export { isFileIntelligenceError };

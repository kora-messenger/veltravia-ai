import { apiRequest } from './client';
import type { ArtifactView } from './files';

const encode = (value: string) => encodeURIComponent(value);

export interface AudioCapabilitiesView {
  readonly provider: {
    readonly providerId: string;
    readonly capabilities: readonly string[];
    readonly supportedFormats: readonly string[] | null;
  };
  readonly providerIsSimulation: boolean;
  readonly limits: {
    readonly maxFileBytes: number;
    readonly maxDurationSeconds: number;
    readonly maxChunks: number;
    readonly maxConcurrentJobs: number;
  };
}
export interface AudioMetadataView {
  readonly fileId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: string | null;
  readonly size: number;
  readonly checksum: string;
  readonly durationSeconds: number | null;
  readonly sampleRateHz: number | null;
  readonly channels: number | null;
  readonly codec: string | null;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}
export interface AudioJobView {
  readonly id: string;
  readonly fileId: string;
  readonly status: string;
  readonly stage: string;
  readonly requestedLanguage: string | null;
  readonly detectedLanguage: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly chunks: number;
  readonly completedChunks: number;
  readonly error: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}
export interface AudioSegmentView {
  readonly id: string;
  readonly startSeconds: number | null;
  readonly endSeconds: number | null;
  readonly speaker: string | null;
  readonly confidence: number | null;
  readonly text: string;
}
export interface AudioTranscriptView {
  readonly fileId: string;
  readonly language: string | null;
  readonly languageAutoDetected: boolean;
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly timestampsAvailable: boolean;
  readonly speakersAvailable: boolean;
  readonly confidence: number | null;
  readonly chunkCount: number;
  readonly segments: readonly AudioSegmentView[];
  readonly text: string;
  readonly trust: 'untrusted_data';
}
export interface AudioSummaryView {
  readonly style: string;
  readonly text: string;
  readonly keyPoints: readonly string[];
  readonly attendees: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly followUps: readonly string[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface AudioAnalysisView {
  readonly summary: AudioSummaryView | null;
  readonly actionItems: readonly {
    description: string;
    assignedTo: string | null;
    deadline: string | null;
    certainty: string;
  }[];
  readonly decisions: readonly { statement: string; certainty: string }[];
  readonly entities: readonly { field: string; value: string; uncertain: boolean }[];
  readonly trust: 'ai_generated';
}
export interface AudioQueryView {
  readonly question: string;
  readonly answer: string;
  readonly supportingSegments: readonly AudioSegmentView[];
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface AudioSearchView {
  readonly query: string;
  readonly truncated: boolean;
  readonly matches: readonly { segment: AudioSegmentView; context: string }[];
  readonly trust: 'untrusted_data';
}
export interface AudioTranslationView {
  readonly targetLanguage: string;
  readonly scope: string;
  readonly segmentId: string | null;
  readonly translatedText: string;
  readonly originalPreserved: boolean;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export const getAudioCapabilities = () =>
  apiRequest<AudioCapabilitiesView>('/api/audio/capabilities');
export const listAudioJobs = () => apiRequest<AudioJobView[]>('/api/audio/jobs');
export const getAudioJob = (jobId: string) =>
  apiRequest<AudioJobView>(`/api/audio/jobs/${encode(jobId)}`);
export const cancelAudioJob = (jobId: string) =>
  apiRequest<AudioJobView>(`/api/audio/jobs/${encode(jobId)}/cancel`, { method: 'POST' });
export const processAudio = (fileId: string, language?: string) =>
  apiRequest<AudioJobView>(`/api/audio/${encode(fileId)}/process`, {
    method: 'POST',
    body: language ? { language } : {},
  });
export const inspectAudio = (fileId: string) =>
  apiRequest<AudioMetadataView>(`/api/audio/${encode(fileId)}/inspect`);
export const getAudioTranscript = (fileId: string) =>
  apiRequest<AudioTranscriptView>(`/api/audio/${encode(fileId)}/transcript`);
export const getAudioAnalysis = (fileId: string) =>
  apiRequest<AudioAnalysisView>(`/api/audio/${encode(fileId)}/analysis`);
export const queryAudio = (fileId: string, question: string) =>
  apiRequest<AudioQueryView>(`/api/audio/${encode(fileId)}/query`, {
    method: 'POST',
    body: { question },
  });
export const searchAudio = (fileId: string, query: string) =>
  apiRequest<AudioSearchView>(`/api/audio/${encode(fileId)}/search`, {
    method: 'POST',
    body: { query },
  });
export const summarizeAudio = (fileId: string, style = 'short') =>
  apiRequest<AudioSummaryView>(`/api/audio/${encode(fileId)}/summarize`, {
    method: 'POST',
    body: { style },
  });
export const extractAudio = (fileId: string, fields?: readonly string[]) =>
  apiRequest<AudioAnalysisView>(`/api/audio/${encode(fileId)}/extract`, {
    method: 'POST',
    body: fields && fields.length ? { fields } : {},
  });
export const translateAudio = (
  fileId: string,
  input: { targetLanguage: string; scope?: string; segmentId?: string; summaryText?: string },
) =>
  apiRequest<AudioTranslationView>(`/api/audio/${encode(fileId)}/translate`, {
    method: 'POST',
    body: input,
  });
export const saveAudioArtifact = (
  fileId: string,
  body: {
    kind: string;
    filename?: string;
    translation?: { translatedText: string; targetLanguage: string; scope: string };
  },
) =>
  apiRequest<ArtifactView>(`/api/audio/${encode(fileId)}/artifacts`, {
    method: 'POST',
    body,
  });
export const audioMediaUrl = (fileId: string) => `/api/audio/${encode(fileId)}/media`;
export const createAudioMemoryCandidates = (fileId: string, projectId: string) =>
  apiRequest<{ created: { id: string; title: string; status: string }[]; note: string }>(
    `/api/audio/${encode(fileId)}/memory-candidates`,
    { method: 'POST', body: { projectId } },
  );

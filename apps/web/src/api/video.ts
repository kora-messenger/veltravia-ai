import { apiRequest } from './client';
const path = (id: string) => `/api/video/${encodeURIComponent(id)}`;
export interface VideoJob {
  id: string;
  fileId: string;
  status: string;
  stage: string;
  operations: number;
  completedOperations: number;
  error: { code: string; message: string } | null;
}
export interface VideoMetadata {
  filename: string;
  format: string | null;
  size: number;
  container: {
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    hasAudio: boolean | null;
  };
}
export interface VideoAnalysis {
  description: { summary: string; observed: string[]; inferences: string[] } | null;
  transcript: {
    text: string;
    segments: { id: string; text: string; startSeconds: number | null; speaker: string | null }[];
  } | null;
  scenes: {
    scenes: {
      id: string;
      startSeconds: number | null;
      endSeconds: number | null;
      observed: string[];
      inferred: string[];
    }[];
  } | null;
  ocr: { text: string } | null;
}
export interface VideoTimeline {
  events: { id: string; timestampSeconds: number | null; kind: string; statement: string }[];
}
export interface VideoQuery {
  answer: string;
  insufficientEvidence: boolean;
  combinedInference: string[];
}
export interface VideoSummary {
  summary: string;
  keyPoints: string[];
  steps: { text: string; timestampSeconds: number | null }[];
  actionItems: { description: string; uncertain: boolean }[];
  observedFailure: string | null;
  suspectedCause: string | null;
}
export const getVideoCapabilities = () =>
  apiRequest<{ providerIsSimulation: boolean }>('/api/video/capabilities');
export const inspectVideo = (id: string) => apiRequest<VideoMetadata>(`${path(id)}/inspect`);
export const getVideoAnalysis = (id: string) => apiRequest<VideoAnalysis>(`${path(id)}/analysis`);
export const processVideo = (id: string) =>
  apiRequest<VideoJob>(`${path(id)}/process`, { method: 'POST', body: {} });
export const getVideoJob = (id: string) =>
  apiRequest<VideoJob>(`/api/video/jobs/${encodeURIComponent(id)}`);
export const cancelVideoJob = (id: string) =>
  apiRequest<VideoJob>(`/api/video/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: {},
  });
export const getVideoTimeline = (id: string) =>
  apiRequest<VideoTimeline>(`${path(id)}/timeline`, { method: 'POST', body: {} });
export const queryVideo = (id: string, question: string) =>
  apiRequest<VideoQuery>(`${path(id)}/ask`, { method: 'POST', body: { question } });
export const summarizeVideo = (id: string, mode: string) =>
  apiRequest<VideoSummary>(`${path(id)}/summarize`, { method: 'POST', body: { mode } });
export const saveVideoArtifact = (id: string, kind: string) =>
  apiRequest<{ filename: string; id: string }>(`${path(id)}/artifact`, {
    method: 'POST',
    body: { kind },
  });
export const videoMediaUrl = (id: string) => `${path(id)}/media`;

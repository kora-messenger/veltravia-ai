import { apiRequest } from './client';

const encode = (value: string) => encodeURIComponent(value);

export interface ImageCapabilitiesView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly capabilities: readonly string[];
    readonly supportedFormats: readonly string[] | null;
    readonly maxBytes: number | null;
    readonly maxDimensionPixels: number | null;
  }[];
  readonly providerIsSimulation: boolean;
  readonly operations: readonly string[];
  readonly limits: {
    readonly maxFileBytes: number;
    readonly maxDimensionPixels: number;
    readonly maxProcessingMs: number;
    readonly maxConcurrentJobs: number;
    readonly maxSearchMatches: number;
    readonly maxCompareImages: number;
  };
}
export interface ImageMetadataView {
  readonly fileId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: string | null;
  readonly size: number;
  readonly checksum: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly colorInfo: {
    readonly bitDepth: number | null;
    readonly colorType: number | null;
    readonly hasAlpha: boolean;
  } | null;
  readonly animated: boolean | null;
  readonly frameCount: number | null;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}
export interface ImageJobView {
  readonly id: string;
  readonly fileId: string;
  readonly status: string;
  readonly stage: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly operations: number;
  readonly completedOperations: number;
  readonly error: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}
export interface ImageDescriptionView {
  readonly summary: string;
  readonly observed: readonly string[];
  readonly inferences: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}
export interface OcrView {
  readonly text: string;
  readonly regions: readonly {
    readonly id: string;
    readonly text: string;
    readonly readingOrder: number | null;
    readonly confidence: number | null;
  }[];
  readonly regionsAvailable: boolean;
  readonly confidenceAvailable: boolean;
  readonly providerId: string;
  readonly createdAt: string;
  readonly trust: 'untrusted_data';
}
export interface ImageAnalysisView {
  readonly description: ImageDescriptionView | null;
  readonly ocr: OcrView | null;
  readonly jobId: string | null;
  readonly providerIsSimulation: boolean;
}
export interface ImageQueryView {
  readonly question: string;
  readonly answer: string;
  readonly insufficientEvidence: boolean;
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface ScreenshotView {
  readonly issues: readonly {
    readonly id: string;
    readonly kind: string;
    readonly statement: string;
    readonly basis: string;
    readonly regionId: string | null;
  }[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface UiStructureView {
  readonly elements: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string | null;
    readonly regionId: string | null;
  }[];
  readonly notes: readonly string[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface ChartView {
  readonly chartType: string;
  readonly title: string | null;
  readonly observed: readonly string[];
  readonly inferences: readonly string[];
  readonly values: readonly string[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface DiagramView {
  readonly nodes: readonly { id: string; label: string; kind: string }[];
  readonly relationships: readonly {
    readonly id: string;
    readonly fromId: string;
    readonly toId: string;
    readonly label: string;
    readonly kind: string;
  }[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface ExtractView {
  readonly fields: readonly { field: string; value: string; uncertain: boolean }[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface CompareView {
  readonly fileAId: string;
  readonly fileBId: string;
  readonly summary: string;
  readonly differences: readonly { kind: string; statement: string; basis: string }[];
  readonly providerId: string;
  readonly providerIsSimulation: boolean;
  readonly trust: 'ai_generated';
}
export interface ImageSearchView {
  readonly query: string;
  readonly truncated: boolean;
  readonly matches: readonly {
    readonly fileId: string;
    readonly reason: string;
    readonly matchedText: string | null;
  }[];
  readonly trust: 'untrusted_data';
}
export interface ImageArtifactView {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

export const getImageCapabilities = () =>
  apiRequest<ImageCapabilitiesView>('/api/image/capabilities');
export const listImageJobs = () => apiRequest<ImageJobView[]>('/api/image/jobs');
export const getImageJob = (jobId: string) =>
  apiRequest<ImageJobView>(`/api/image/jobs/${encode(jobId)}`);
export const cancelImageJob = (jobId: string) =>
  apiRequest<ImageJobView>(`/api/image/jobs/${encode(jobId)}/cancel`, { method: 'POST' });
export const processImage = (fileId: string) =>
  apiRequest<ImageJobView>(`/api/image/${encode(fileId)}/process`, { method: 'POST', body: {} });
export const inspectImage = (fileId: string) =>
  apiRequest<ImageMetadataView>(`/api/image/${encode(fileId)}/inspect`);
export const getImageAnalysis = (fileId: string) =>
  apiRequest<ImageAnalysisView>(`/api/image/${encode(fileId)}/analysis`);
export const queryImage = (fileId: string, question: string) =>
  apiRequest<ImageQueryView>(`/api/image/${encode(fileId)}/query`, {
    method: 'POST',
    body: { question },
  });
export const analyzeScreenshot = (fileId: string) =>
  apiRequest<ScreenshotView>(`/api/image/${encode(fileId)}/screenshot`, {
    method: 'POST',
    body: {},
  });
export const getUiStructure = (fileId: string) =>
  apiRequest<UiStructureView>(`/api/image/${encode(fileId)}/ui-structure`, {
    method: 'POST',
    body: {},
  });
export const analyzeChart = (fileId: string) =>
  apiRequest<ChartView>(`/api/image/${encode(fileId)}/chart`, { method: 'POST', body: {} });
export const analyzeDiagram = (fileId: string) =>
  apiRequest<DiagramView>(`/api/image/${encode(fileId)}/diagram`, { method: 'POST', body: {} });
export const extractImageFields = (fileId: string, fields: readonly string[]) =>
  apiRequest<ExtractView>(`/api/image/${encode(fileId)}/extract`, {
    method: 'POST',
    body: { fields },
  });
export const compareImages = (fileId: string, otherFileId: string) =>
  apiRequest<CompareView>(`/api/image/${encode(fileId)}/compare`, {
    method: 'POST',
    body: { otherFileId },
  });
export const searchImage = (fileId: string, query: string) =>
  apiRequest<ImageSearchView>(`/api/image/${encode(fileId)}/search?q=${encode(query)}`);
export const searchAllImages = (query: string, projectId?: string) =>
  apiRequest<ImageSearchView>('/api/image/search', {
    method: 'POST',
    body: projectId ? { query, projectId } : { query },
  });
export const saveImageArtifact = (fileId: string, kind: string) =>
  apiRequest<ImageArtifactView>(`/api/image/${encode(fileId)}/artifact`, {
    method: 'POST',
    body: { kind },
  });
export const imageMediaUrl = (fileId: string) => `/api/image/${encode(fileId)}/media`;

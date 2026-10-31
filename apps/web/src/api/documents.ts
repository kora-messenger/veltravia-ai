import { apiRequest } from './client';

const path = (id: string) => `/api/documents/${encodeURIComponent(id)}`;

export interface DocumentInspection {
  fileId: string;
  format: string;
  detectedFrom: string;
  byteSize: number;
  capabilities: readonly string[];
  simulated: boolean;
}

export interface DocumentJob {
  jobId: string;
  fileId: string;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DocumentElement {
  id: string;
  type: string;
  text: string;
  level: number | null;
  tableId: string | null;
  imageCount: number | null;
  linkUrl: string | null;
}

export interface DocumentTable {
  id: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface DocumentSection {
  id: string;
  title: string;
  elementIds: readonly string[];
}

export interface DocumentStructure {
  fileId: string;
  format: string;
  elements: readonly DocumentElement[];
  tables: readonly DocumentTable[];
  sections: readonly DocumentSection[];
  metadata: readonly { name: string; value: string }[];
  pageCount: number | null;
  slideCount: number | null;
  sheetCount: number | null;
  truncated: boolean;
  trustTag: string;
}

export interface DocumentEvidence {
  quote: string;
  ref: { kind: string; id: string; label: string };
}

export interface DocumentAnswer {
  answer: string;
  evidence: readonly DocumentEvidence[];
  confidence: 'low' | 'medium' | 'high';
  trustTag: string;
}

export interface DocumentSummary {
  summary: string;
  mode: string;
  trustTag: string;
}

export interface DocumentSearchResult {
  fileId: string;
  matches: readonly { elementId: string; snippet: string; score: number }[];
  total: number;
  truncated: boolean;
  trustTag: string;
}

export interface DocumentEntities {
  entities: readonly { name: string; type: string }[];
  trustTag: string;
}

export interface SpreadsheetView {
  sheets: readonly {
    name: string;
    rowCount: number;
    columnCount: number;
    headers: readonly string[];
    formulaCells: number;
  }[];
}

export interface PresentationView {
  slides: readonly {
    index: number;
    title: string;
    bulletTexts: readonly string[];
    notes: string;
  }[];
}

export interface DocumentMemoryCandidate {
  title: string;
  content: string;
  source: string;
  sourceKind: string;
  elementIds: readonly string[];
}

export interface DocumentArtifact {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export const getDocumentCapabilities = () =>
  apiRequest<{ providerIsSimulation: boolean; artifactKinds: readonly string[] }>(
    '/api/documents/capabilities',
  );

export const inspectDocument = (id: string) =>
  apiRequest<DocumentInspection>(`${path(id)}/inspect`);

export const processDocument = (id: string) =>
  apiRequest<DocumentJob>(`${path(id)}/process`, { method: 'POST', body: {} });

export const cancelDocumentJob = (jobId: string) =>
  apiRequest<DocumentJob>(`/api/documents/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: {},
  });

export const getDocumentStructure = (id: string) =>
  apiRequest<DocumentStructure>(`${path(id)}/structure`);

export const searchDocument = (id: string, query: string) =>
  apiRequest<DocumentSearchResult>(`${path(id)}/search`, { method: 'POST', body: { query } });

export const askDocument = (id: string, question: string) =>
  apiRequest<DocumentAnswer>(`${path(id)}/ask`, { method: 'POST', body: { question } });

export const summarizeDocument = (id: string, mode: string) =>
  apiRequest<DocumentSummary>(`${path(id)}/summary`, { method: 'POST', body: { mode } });

export const getDocumentEntities = (id: string) =>
  apiRequest<DocumentEntities>(`${path(id)}/entities`);

export const getSpreadsheetView = (id: string) =>
  apiRequest<SpreadsheetView>(`${path(id)}/spreadsheet`);

export const getPresentationView = (id: string) =>
  apiRequest<PresentationView>(`${path(id)}/presentation`);

export const getDocumentMemoryCandidates = (id: string) =>
  apiRequest<readonly DocumentMemoryCandidate[]>(`${path(id)}/memory-candidates`);

export const saveDocumentArtifact = (
  id: string,
  kind: string,
  extras: { mode?: string; query?: string; otherFileId?: string } = {},
) =>
  apiRequest<DocumentArtifact>(`${path(id)}/artifact`, {
    method: 'POST',
    body: { kind, ...extras },
  });

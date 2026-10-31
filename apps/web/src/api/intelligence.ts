import { apiRequest } from './client';

const base = '/api/intelligence';

export interface ReasoningDisclosure {
  readonly provider: string;
  readonly mode: string;
  readonly simulated: boolean;
  readonly detail: string;
}

export interface IntelligenceCapabilities {
  readonly reasoning: ReasoningDisclosure;
  readonly limits: Record<string, number>;
}

export interface FreshnessView {
  readonly retrievedAt: string;
  readonly ageSeconds: number;
  readonly staleAfterSeconds: number;
  readonly stale: boolean;
}

export interface SourceView {
  readonly sourceId: string;
  readonly provider: string;
  readonly providerName: string;
  readonly sourceType: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly contentVersion: string;
  readonly retrievedAt: string;
  readonly modifiedAt: string | null;
  readonly sourceUrl: string | null;
  readonly permissions: readonly string[];
  readonly freshness: FreshnessView;
  readonly trustTag: string;
}

export interface ProviderAvailability {
  readonly provider: string;
  readonly available: boolean;
  readonly detail: string;
}

export interface SourcesResponse {
  readonly sources: readonly SourceView[];
  readonly providers: readonly ProviderAvailability[];
}

export interface SearchHit {
  readonly source: SourceView;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly snippet: string;
  readonly locator: {
    readonly label: string;
    readonly section: string | null;
    readonly line: number | null;
  };
  readonly reasons: readonly string[];
}

export interface SearchResponse {
  readonly totalMatched: number;
  readonly duplicatesRemoved: number;
  readonly sourcesScanned: number;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly searchedProviders: readonly string[];
  readonly unavailableProviders: readonly { readonly provider: string; readonly detail: string }[];
  readonly hits: readonly SearchHit[];
}

export interface EvidenceView {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly resourceName: string;
  readonly locator: {
    readonly label: string;
    readonly section: string | null;
    readonly line: number | null;
  };
  readonly excerpt: string;
  readonly revision: string;
  readonly retrievedAt: string;
  readonly trustTag: string;
  readonly verified: boolean;
}

export interface ClaimView {
  readonly claimId: string;
  readonly statement: string;
  readonly kind: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
}

export interface ContradictionView {
  readonly contradictionId: string;
  readonly kind: string;
  readonly topic: string;
  readonly explanation: string;
  readonly confidence: number;
  readonly resolvable: boolean;
  readonly resolution: string | null;
  readonly detectedBy: string;
  readonly statements: readonly {
    readonly text: string;
    readonly sourceId: string;
    readonly resourceName: string;
    readonly evidenceId: string;
    readonly revision: string;
    readonly modifiedAt: string | null;
  }[];
}

export interface RelationshipView {
  readonly relationshipId: string;
  readonly kind: string;
  readonly fromSourceId: string;
  readonly toSourceId: string;
  readonly explanation: string;
  readonly confidence: number;
  readonly inferred: boolean;
}

export interface InformationGapView {
  readonly gapId: string;
  readonly kind: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface SynthesisAnswer {
  readonly question: string;
  readonly intent: string;
  readonly status: 'answered' | 'partial' | 'no_evidence';
  readonly summary: string;
  readonly claims: readonly ClaimView[];
  readonly contradictions: readonly ContradictionView[];
  readonly relationships: readonly RelationshipView[];
  readonly gaps: readonly InformationGapView[];
  readonly sources: readonly SourceView[];
  readonly evidence: readonly EvidenceView[];
  readonly reasoning: ReasoningDisclosure;
  readonly searchedProviders: readonly string[];
  readonly unavailableProviders: readonly { readonly provider: string; readonly detail: string }[];
  readonly generatedAt: string;
  readonly truncated: boolean;
}

export interface ComparisonResult {
  readonly participants: readonly {
    readonly source: SourceView;
    readonly evidence: readonly EvidenceView[];
    readonly outline: readonly string[];
    readonly wordCount: number;
  }[];
  readonly agreements: readonly ClaimView[];
  readonly contradictions: readonly ContradictionView[];
  readonly onlyIn: readonly { readonly sourceId: string; readonly headings: readonly string[] }[];
  readonly reasoning: ReasoningDisclosure;
  readonly truncated: boolean;
}

export interface SynthesisJobView {
  readonly jobId: string;
  readonly question: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export function getCapabilities(): Promise<IntelligenceCapabilities> {
  return apiRequest<IntelligenceCapabilities>(`${base}/capabilities`);
}

export function listSources(
  params: {
    readonly q?: string;
    readonly provider?: string;
  } = {},
): Promise<SourcesResponse> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.provider) query.set('provider', params.provider);
  const suffix = query.toString();
  return apiRequest<SourcesResponse>(`${base}/sources${suffix ? `?${suffix}` : ''}`);
}

export function searchSources(
  text: string,
  params: { readonly provider?: string; readonly limit?: number } = {},
  fetchImpl?: typeof fetch,
): Promise<SearchResponse> {
  const query = new URLSearchParams({ q: text });
  if (params.provider) query.set('provider', params.provider);
  if (params.limit) query.set('limit', String(params.limit));
  return apiRequest<SearchResponse>(`${base}/search?${query.toString()}`, { fetchImpl });
}

export function analyze(
  question: string,
  params: { readonly provider?: string; readonly projectId?: string } = {},
  fetchImpl?: typeof fetch,
): Promise<SynthesisAnswer> {
  const body: Record<string, unknown> = { question };
  if (params.provider) body.provider = params.provider;
  if (params.projectId) body.projectId = params.projectId;
  return apiRequest<SynthesisAnswer>(`${base}/analyze`, { method: 'POST', body, fetchImpl });
}

export function compare(
  sourceIds: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<ComparisonResult> {
  return apiRequest<ComparisonResult>(`${base}/compare`, {
    method: 'POST',
    body: { sourceIds: [...sourceIds] },
    fetchImpl,
  });
}

export function startJob(question: string): Promise<SynthesisJobView> {
  return apiRequest<SynthesisJobView>(`${base}/jobs`, { method: 'POST', body: { question } });
}

export function getJob(jobId: string, fetchImpl?: typeof fetch): Promise<SynthesisJobView> {
  return apiRequest<SynthesisJobView>(`${base}/jobs/${encodeURIComponent(jobId)}`, { fetchImpl });
}

export function getJobResult(jobId: string, fetchImpl?: typeof fetch): Promise<SynthesisAnswer> {
  return apiRequest<SynthesisAnswer>(`${base}/jobs/${encodeURIComponent(jobId)}/result`, {
    fetchImpl,
  });
}

export function cancelJob(jobId: string, fetchImpl?: typeof fetch): Promise<SynthesisJobView> {
  return apiRequest<SynthesisJobView>(`${base}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: {},
    fetchImpl,
  });
}

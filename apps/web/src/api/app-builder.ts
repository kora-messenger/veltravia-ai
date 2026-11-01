import { apiRequest } from './client';

/**
 * Typed client for the App Builder (Step 30).
 *
 * The browser renders what the server reports: the registry's own support
 * levels, the validator's own issues, and the plan's own files. It never
 * decides that a technology is supported, and it never claims a build ran.
 */

const base = '/api/app-builder';

export type SupportLevel = 'executable' | 'scaffold' | 'planned';
export type TechnologyKind = 'language' | 'framework';
export type ProjectKind =
  | 'web'
  | 'mobile'
  | 'backend'
  | 'fullstack'
  | 'library'
  | 'cli'
  | 'data'
  | 'smart-contract'
  | 'other';

export interface CommandPlanView {
  readonly argv: readonly string[];
  readonly description: string;
  readonly maxSeconds: number;
}

export interface PreviewView {
  readonly mode: 'static' | 'server' | 'device-emulator' | 'none';
  readonly ports: readonly number[];
  readonly note: string;
}

export interface TechnologyView {
  readonly kind: TechnologyKind;
  readonly id: string;
  readonly name: string;
  readonly layer: string;
  readonly versions: readonly string[];
  readonly supportLevel: SupportLevel;
  readonly build?: CommandPlanView;
  readonly test?: CommandPlanView;
  readonly preview: PreviewView;
  readonly deployment: { readonly targets: readonly string[]; readonly note: string };
  readonly unsupported: readonly string[];
  readonly languageId?: string;
  readonly projectKinds?: readonly ProjectKind[];
}

export interface ValidationIssueView {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export interface SpecificationReviewView {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssueView[];
  readonly resolved: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly supportLevel: SupportLevel;
  }[];
  readonly supportLevel: SupportLevel;
  readonly unsupported: readonly { readonly id: string; readonly reason: string }[];
  readonly notes: readonly string[];
}

export interface PlannedFileView {
  readonly path: string;
  readonly description: string;
  readonly content: string;
}

export interface ScaffoldPlanView {
  readonly id: string;
  readonly status: 'planned' | 'materialized';
  readonly createdAt: string;
  readonly specification: { readonly name: string; readonly projectKind: ProjectKind };
  readonly review: SpecificationReviewView;
  readonly files: readonly PlannedFileView[];
  readonly buildCommand: CommandPlanView | null;
  readonly testCommand: CommandPlanView | null;
  readonly preview: PreviewView;
}

export interface TechnologyStackDetectionView {
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly confidence: number;
    readonly supportLevel: SupportLevel;
  }[];
  readonly languages: readonly {
    readonly id: string;
    readonly name: string;
    readonly confidence: number;
  }[];
  readonly frameworks: readonly {
    readonly id: string;
    readonly name: string;
    readonly confidence: number;
  }[];
  readonly unknownLanguages: readonly string[];
  readonly unrecognisedFiles: number;
  readonly notes: readonly string[];
}

export interface MaterializeResultView {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly createdFiles: readonly string[];
  readonly createdDirectories: readonly string[];
}

export function fetchCapabilities(): Promise<{ capabilities: unknown }> {
  return apiRequest(`${base}`);
}

export async function fetchRegistry(): Promise<readonly TechnologyView[]> {
  const response = await apiRequest<{ technologies: TechnologyView[] }>(`${base}/registry`);
  return response.technologies;
}

export async function validateSpecification(
  specification: Record<string, unknown>,
): Promise<SpecificationReviewView> {
  const response = await apiRequest<{ review: SpecificationReviewView }>(`${base}/spec/validate`, {
    method: 'POST',
    body: { specification },
  });
  return response.review;
}

export async function detectStack(
  files: readonly { path: string; text?: string }[],
): Promise<TechnologyStackDetectionView> {
  const response = await apiRequest<{ detection: TechnologyStackDetectionView }>(`${base}/detect`, {
    method: 'POST',
    body: { files },
  });
  return response.detection;
}

export async function createPlan(
  specification: Record<string, unknown>,
): Promise<ScaffoldPlanView> {
  const response = await apiRequest<{ plan: ScaffoldPlanView }>(`${base}/plans`, {
    method: 'POST',
    body: { specification },
  });
  return response.plan;
}

export async function listPlans(): Promise<readonly ScaffoldPlanView[]> {
  const response = await apiRequest<{ plans: ScaffoldPlanView[] }>(`${base}/plans`);
  return response.plans;
}

export async function materializePlan(planId: string): Promise<MaterializeResultView> {
  const response = await apiRequest<{ result: MaterializeResultView }>(
    `${base}/plans/${encodeURIComponent(planId)}/materialize`,
    { method: 'POST' },
  );
  return response.result;
}

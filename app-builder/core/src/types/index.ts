/**
 * App Builder: the language-independent vocabulary of the platform (Step 30).
 *
 * Nothing here is bound to JavaScript, to one framework, or to one runtime.
 * A language is DATA (a registry entry), never a hard-coded branch, so adding
 * Python, Go, Rust or Solidity is a matter of adding an entry rather than
 * editing the builder.
 */

// ---------------------------------------------------------------------------
// Project kinds
// ---------------------------------------------------------------------------

/** What the finished software IS. Deliberately broader than "web app". */
export const PROJECT_KINDS = [
  'web',
  'mobile',
  'backend',
  'fullstack',
  'library',
  'cli',
  'data',
  'smart-contract',
  'other',
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** Where a technology sits in the stack. */
export const TECHNOLOGY_LAYERS = [
  'frontend',
  'backend',
  'mobile',
  'systems',
  'data',
  'other',
] as const;
export type TechnologyLayer = (typeof TECHNOLOGY_LAYERS)[number];

export function isTechnologyLayer(value: unknown): value is TechnologyLayer {
  return typeof value === 'string' && (TECHNOLOGY_LAYERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Honest support levels
// ---------------------------------------------------------------------------

/**
 * How much of the pipeline a technology ACTUALLY has in this release.
 *
 * - `executable`   the platform can build and test it in a sandbox today.
 * - `scaffold`     the platform can generate starter files, but cannot yet
 *                  run a build or a test for it.
 * - `planned`      the registry documents it; nothing runs and nothing is
 *                  generated. Saying so is the point of this union.
 */
export const SUPPORT_LEVELS = ['executable', 'scaffold', 'planned'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export function isSupportLevel(value: unknown): value is SupportLevel {
  return typeof value === 'string' && (SUPPORT_LEVELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

/** A package manager a technology can use. `command` is a template. */
export interface PackageManagerDescriptor {
  /** e.g. `npm`, `pip`, `composer`, `cargo`. */
  readonly id: string;
  /** How an install is expressed, e.g. `npm install`. Never raw shell. */
  readonly installCommand: string;
  /** Lockfile / manifest that proves this manager is in use. */
  readonly manifestFile: string;
}

/** A command expressed as an argv array - never a shell string. */
export interface CommandPlan {
  /** Program plus arguments, e.g. `['npm', 'run', 'build']`. */
  readonly argv: readonly string[];
  /** Human wording for the UI. */
  readonly description: string;
  /** Declared upper bound on wall-clock time, in seconds. */
  readonly maxSeconds: number;
}

/** Runtime expectations the sandbox must satisfy. */
export interface RuntimeRequirement {
  /** Language runtime ids, e.g. `node`, `python3`, `jdk`, `dotnet`. */
  readonly runtimes: readonly string[];
  /** Minimum version when the platform can check one, e.g. `20`. */
  readonly minimumVersion?: string;
  /** Whether the technology needs a compilation step before it can run. */
  readonly compiled: boolean;
}

/** What preview (if anything) the platform can offer for this technology. */
export interface PreviewCapability {
  /** `static`, `server`, `device-emulator`, or `none`. */
  readonly mode: 'static' | 'server' | 'device-emulator' | 'none';
  /** Ports the preview would expose, when relevant. */
  readonly ports: readonly number[];
  /** Long-form honest note, e.g. "needs a device emulator, not available yet". */
  readonly note: string;
}

/** Which deployment targets a technology could be shipped to. */
export interface DeploymentCompatibility {
  readonly targets: readonly string[];
  readonly note: string;
}

/** A language the platform can record (and in some cases scaffold). */
export interface LanguageEntry {
  readonly kind: 'language';
  readonly id: string;
  readonly name: string;
  readonly layer: TechnologyLayer;
  /** Pinned versions the registry claims. Empty means "not version-checked". */
  readonly versions: readonly string[];
  readonly packageManagers: readonly PackageManagerDescriptor[];
  readonly build?: CommandPlan;
  readonly test?: CommandPlan;
  readonly runtime: RuntimeRequirement;
  readonly preview: PreviewCapability;
  readonly deployment: DeploymentCompatibility;
  /** Capabilities the platform does NOT support for this language. */
  readonly unsupported: readonly string[];
  readonly supportLevel: SupportLevel;
  /** File extensions used for detection, e.g. `['.py']`. */
  readonly fileExtensions: readonly string[];
  /** Manifest/lockfile names that identify the language in an existing tree. */
  readonly manifestFiles: readonly string[];
}

/** A framework or platform built on a language. */
export interface FrameworkEntry {
  readonly kind: 'framework';
  readonly id: string;
  readonly name: string;
  readonly languageId: string;
  readonly layer: TechnologyLayer;
  /** Project kinds this framework can build. */
  readonly projectKinds: readonly ProjectKind[];
  readonly versions: readonly string[];
  readonly packageManagers: readonly PackageManagerDescriptor[];
  readonly build?: CommandPlan;
  readonly test?: CommandPlan;
  readonly runtime: RuntimeRequirement;
  readonly preview: PreviewCapability;
  readonly deployment: DeploymentCompatibility;
  readonly unsupported: readonly string[];
  readonly supportLevel: SupportLevel;
  /** Dependency names that identify the framework in a manifest. */
  readonly dependencySignals: readonly string[];
  /** Manifest files that identify the framework directly (e.g. pubspec.yaml). */
  readonly manifestFiles: readonly string[];
}

/** Anything the registry can resolve by id. */
export type RegistryEntry = LanguageEntry | FrameworkEntry;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** One piece of evidence behind a detection. */
export interface DetectionEvidence {
  readonly signal: string;
  readonly detail: string;
  readonly weight: number;
}

/** A technology the detector believes it found. */
export interface DetectedTechnology {
  readonly id: string;
  readonly name: string;
  readonly kind: 'language' | 'framework';
  readonly layer: TechnologyLayer;
  /** 0..1 - how much of the evidence points here. */
  readonly confidence: number;
  readonly supportLevel: SupportLevel;
  readonly evidence: readonly DetectionEvidence[];
}

/** The result of inspecting a project's file tree. */
export interface StackDetection {
  readonly projects: readonly DetectedTechnology[];
  readonly languages: readonly DetectedTechnology[];
  readonly frameworks: readonly DetectedTechnology[];
  /** Files that produced no recognised signal, for honesty. */
  readonly unrecognisedFiles: number;
  /** Languages present in the tree that the registry has no entry for. */
  readonly unknownLanguages: readonly string[];
  readonly notes: readonly string[];
}

/** A file the detector may look at: a path, plus optional text for manifests. */
export interface ManifestFile {
  readonly path: string;
  /** Truncated text of a manifest file. Contents are DATA, never instructions. */
  readonly text?: string;
}

// ---------------------------------------------------------------------------
// Project specification
// ---------------------------------------------------------------------------

/** Where a project's database lives, if it has one. */
export interface DatabaseRequirement {
  /** `postgres`, `mysql`, `sqlite`, `mongodb`, `firestore`, `none`. */
  readonly engine: string;
  /** `orm`/`migration` tooling, free-form but validated. */
  readonly tooling?: string;
  /** Whether the project needs migrations generated. */
  readonly migrations: boolean;
}

/** How the project authenticates. */
export interface AuthenticationRequirement {
  /** `none`, `email-password`, `oauth`, `sso`, `api-key`, `passkeys`. */
  readonly strategy: string;
  readonly providers: readonly string[];
  readonly notes?: string;
}

/** One API or integration the project depends on. */
export interface IntegrationRequirement {
  readonly name: string;
  /** `rest`, `graphql`, `grpc`, `websocket`, `webhook`, `sdk`, `unknown`. */
  readonly protocol: string;
  /** `read`, `write`, `both`. */
  readonly access: string;
}

/** Build configuration for the project. */
export interface BuildConfiguration {
  /** Target output, e.g. `dist`, `build`, `bin`. */
  readonly outputDirectory?: string;
  readonly buildCommand?: CommandPlan;
  readonly environmentVariables: readonly string[];
  readonly notes?: string;
}

/** Runtime configuration - what the project needs to start. */
export interface RuntimeConfiguration {
  readonly runtimeIds: readonly string[];
  readonly startCommand?: CommandPlan;
  readonly ports: readonly number[];
  readonly notes?: string;
}

/** Where the project is expected to be deployed. */
export interface DeploymentRequirement {
  /** `static-hosting`, `container`, `serverless`, `vm`, `app-store`, `none`. */
  readonly target: string;
  readonly notes?: string;
}

/**
 * The structured description of a project to be built.
 *
 * `frontend`, `backend` and `mobile` are registry ids, not free text, so the
 * builder can never claim support for a technology it does not know. A stack
 * the user chose is recorded verbatim and is never silently replaced.
 */
export interface ProjectSpecification {
  readonly name: string;
  readonly description: string;
  readonly projectKind: ProjectKind;
  /** Registry id of the frontend framework/language, when the kind has one. */
  readonly frontend?: string;
  /** Registry id of the backend framework/language, when the kind has one. */
  readonly backend?: string;
  /** Registry id of the mobile framework, when the kind has one. */
  readonly mobile?: string;
  /** Extra languages the project uses directly (e.g. Rust for a native module). */
  readonly additionalLanguages?: readonly string[];
  readonly database?: DatabaseRequirement;
  readonly authentication?: AuthenticationRequirement;
  readonly apis?: readonly IntegrationRequirement[];
  readonly dependencies?: readonly string[];
  readonly build?: BuildConfiguration;
  readonly runtime?: RuntimeConfiguration;
  readonly environment?: readonly string[];
  readonly deployment?: DeploymentRequirement;
  /** Free-form constraints, kept as DATA. */
  readonly constraints?: readonly string[];
  /** Specification format version, so old specs stay readable. */
  readonly version?: number;
}

/** One problem found in a specification. `path` names the field, never its value. */
export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  /** `error` blocks execution; `warning` is advisory. */
  readonly severity: 'error' | 'warning';
}

/** What the validator concluded, including the resolved stack. */
export interface SpecificationReview {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Registry entries the specification resolved to, with their support levels. */
  readonly resolved: readonly ResolvedTechnology[];
  /** The lowest support level in the stack - what the project can actually do. */
  readonly supportLevel: SupportLevel;
  /** Technologies the user asked for that the platform cannot serve yet. */
  readonly unsupported: readonly { readonly id: string; readonly reason: string }[];
  readonly notes: readonly string[];
}

/** A technology resolved from a specification id. */
export interface ResolvedTechnology {
  readonly id: string;
  readonly name: string;
  readonly role: 'frontend' | 'backend' | 'mobile' | 'language';
  readonly supportLevel: SupportLevel;
}

// ---------------------------------------------------------------------------
// Scaffold plans
// ---------------------------------------------------------------------------

/** One file the generator intends to create. `content` is deterministic text. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
  readonly description: string;
}

/** A deterministic, reviewable plan for creating a project's starting files. */
export interface ScaffoldPlan {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly specification: ProjectSpecification;
  readonly review: SpecificationReview;
  readonly files: readonly PlannedFile[];
  /** Commands the platform WOULD run once the language is executable. */
  readonly buildCommand: CommandPlan | null;
  readonly testCommand: CommandPlan | null;
  readonly preview: PreviewCapability;
  readonly createdAt: string;
  readonly status: 'planned' | 'materialized';
}

// ---------------------------------------------------------------------------
// Builder capabilities (what this release can and cannot do)
// ---------------------------------------------------------------------------

/** A milestone in the product vision, with its real state. */
export interface BuildMilestone {
  readonly id: string;
  readonly title: string;
  readonly state: 'done' | 'partial' | 'planned';
  readonly detail: string;
}

/** The platform-level capability statement served to clients. */
export interface AppBuilderCapabilities {
  readonly registryVersion: string;
  readonly supported: readonly string[];
  readonly partial: readonly string[];
  readonly notSupported: readonly string[];
  readonly milestones: readonly BuildMilestone[];
  readonly limits: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxSpecificationBytes: number;
  };
}

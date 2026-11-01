/**
 * The project generator (Step 30).
 *
 * Pure and deterministic: a specification goes in, a reviewable list of files
 * comes out. Nothing here writes, touches a filesystem, or runs a command - the
 * manager materializes a plan through an explicit port, so plan review and
 * execution stay separable.
 *
 * The generator REFUSES a stack it cannot scaffold instead of quietly dropping
 * the part it cannot handle. A user who asked for Django gets told that Django
 * is planned, not a React app they did not ask for.
 */

import { AppBuilderError } from '../errors/index.js';
import type { LanguageFrameworkRegistry } from '../registry/index.js';
import { assertValidSpecification } from '../spec/index.js';
import type {
  CommandPlan,
  PlannedFile,
  PreviewCapability,
  ProjectSpecification,
  ScaffoldPlan,
  SpecificationReview,
} from '../types/index.js';
import { hasTemplate, TEMPLATES } from './templates.js';

export const GENERATION_LIMITS = {
  maxFiles: 80,
  maxFileBytes: 200_000,
  maxTotalBytes: 1_000_000,
} as const;

export interface GeneratePlanInput {
  readonly ownerRef: string;
  readonly projectId?: string | null;
  readonly specification: unknown;
  readonly planId: string;
  readonly now: string;
}

/** Files every generated project gets, whatever the language. */
function sharedFiles(spec: ProjectSpecification): readonly PlannedFile[] {
  const specRecord = {
    name: spec.name,
    description: spec.description,
    projectKind: spec.projectKind,
    frontend: spec.frontend ?? null,
    backend: spec.backend ?? null,
    mobile: spec.mobile ?? null,
    additionalLanguages: spec.additionalLanguages ?? [],
    database: spec.database ?? null,
    authentication: spec.authentication ?? null,
    apis: spec.apis ?? [],
    dependencies: spec.dependencies ?? [],
    build: spec.build ?? null,
    runtime: spec.runtime ?? null,
    environment: spec.environment ?? [],
    deployment: spec.deployment ?? null,
    constraints: spec.constraints ?? [],
    version: spec.version ?? 1,
  };

  return [
    {
      path: 'README.md',
      description: 'What this project is and how to work on it.',
      content: `# ${spec.name}

${spec.description || 'A Veltravia project.'}

## Stack

- Kind: ${spec.projectKind}
${spec.frontend === undefined ? '' : `- Frontend: ${spec.frontend}\n`}${spec.backend === undefined ? '' : `- Backend: ${spec.backend}\n`}${spec.mobile === undefined ? '' : `- Mobile: ${spec.mobile}\n`}
## Status

These files were scaffolded by the Veltravia App Builder. They are starter
files, not a finished application: every screen, route and behaviour still has
to be written.

Build and test commands are declared by the technology registry and are NOT
executed by this release, because the sandbox engine is simulated.
`,
    },
    {
      path: '.gitignore',
      description: 'Keeps build output and local secrets out of git.',
      content: `node_modules/
dist/
build/
.env
.env.*
*.log
.DS_Store
__pycache__/
*.pyc
.venv/
target/
.dart_tool/
build/
`,
    },
    {
      path: 'veltravia.project.json',
      description: 'The specification this project was generated from.',
      content: `${JSON.stringify(specRecord, null, 2)}\n`,
    },
  ];
}

function commandsFor(
  registry: LanguageFrameworkRegistry,
  ids: readonly string[],
): { build: CommandPlan | null; test: CommandPlan | null; preview: PreviewCapability } {
  let build: CommandPlan | null = null;
  let test: CommandPlan | null = null;
  let preview: PreviewCapability = {
    mode: 'none',
    ports: [],
    note: 'No preview is available for this stack in this release.',
  };

  for (const id of ids) {
    const entry = registry.find(id);
    if (entry === undefined) continue;
    // The first stack entry that declares a command wins: the primary role
    // decides how the project is built, which matches how the files are laid out.
    if (build === null && entry.build !== undefined) build = entry.build;
    if (test === null && entry.test !== undefined) test = entry.test;
    if (preview.mode === 'none' && entry.preview.mode !== 'none') preview = entry.preview;
  }

  return { build, test, preview };
}

/**
 * Builds a scaffold plan. Throws `APP_BUILDER_UNSUPPORTED_TECHNOLOGY` when a
 * requested technology has no template, so a plan is never partially invented.
 */
export function buildScaffoldPlan(
  input: GeneratePlanInput,
  registry: LanguageFrameworkRegistry,
): ScaffoldPlan {
  const review = assertValidSpecification(input.specification, registry);
  const spec = input.specification as ProjectSpecification;

  const stackIds = [
    spec.frontend,
    spec.mobile,
    spec.backend,
    ...(spec.additionalLanguages ?? []),
  ].filter((value): value is string => typeof value === 'string');

  const unscaffoldable = stackIds.filter((id) => {
    const entry = registry.find(id);
    if (entry === undefined) return true;
    return entry.supportLevel === 'planned' || !hasTemplate(id);
  });

  if (unscaffoldable.length > 0) {
    const names = unscaffoldable.map((id) => registry.find(id)?.name ?? id);
    throw new AppBuilderError(
      'APP_BUILDER_UNSUPPORTED_TECHNOLOGY',
      `This release cannot scaffold ${names.join(', ')}. The stack was not replaced: choose a technology with scaffold support, or keep this specification as a plan.`,
      { technologies: unscaffoldable },
    );
  }

  const files: PlannedFile[] = [];
  const seen = new Set<string>();

  const addFiles = (list: readonly PlannedFile[]): void => {
    for (const file of list) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
  };

  // Role order matters: the primary experience claims shared paths first.
  for (const id of stackIds) {
    const template = TEMPLATES[id];
    if (template === undefined) continue;
    addFiles(template(spec));
  }
  addFiles(sharedFiles(spec));

  if (files.length > GENERATION_LIMITS.maxFiles) {
    throw new AppBuilderError(
      'APP_BUILDER_LIMIT_EXCEEDED',
      `This scaffold would create ${files.length} files, above the ${GENERATION_LIMITS.maxFiles} file limit.`,
      { fileCount: files.length },
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > GENERATION_LIMITS.maxFileBytes) {
      throw new AppBuilderError(
        'APP_BUILDER_LIMIT_EXCEEDED',
        `"${file.path}" is larger than a single generated file may be.`,
        { path: file.path },
      );
    }
    totalBytes += bytes;
    if (totalBytes > GENERATION_LIMITS.maxTotalBytes) {
      throw new AppBuilderError(
        'APP_BUILDER_LIMIT_EXCEEDED',
        'This scaffold is larger than the generated-output limit.',
        { totalBytes },
      );
    }
    if (file.path.startsWith('/') || file.path.includes('..')) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        'A generated path escapes the workspace.',
        {
          path: file.path,
        },
      );
    }
  }

  const { build, test, preview } = commandsFor(registry, stackIds);

  return {
    id: input.planId,
    ownerRef: input.ownerRef,
    projectId: input.projectId ?? null,
    specification: spec,
    review: review as SpecificationReview,
    files,
    buildCommand: build,
    testCommand: test,
    preview,
    createdAt: input.now,
    status: 'planned',
  };
}

import type { BackendSectionName, BackendStructure, BackendStructureSection } from './types.js';

/**
 * Path-only classification of backend files.
 *
 * The rules are deliberately boring: a name or a directory says what a file is
 * for, and a file that fits nothing stays in `utilities` instead of being
 * forced into a category. No contents are read here, and no framework is
 * assumed - the caller passes the detected framework or null.
 */

interface Rule {
  readonly section: BackendSectionName;
  readonly label: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    section: 'routes',
    label: 'Routes',
    pattern: /(^|\/)(routes?|controllers?|handlers?|endpoints?|api|resources?)\//i,
  },
  {
    section: 'services',
    label: 'Services',
    pattern: /(^|\/)(services?|domain|usecases?|use-cases|core|logic)\//i,
  },
  {
    section: 'models',
    label: 'Models & schemas',
    pattern: /(^|\/)(models?|schemas?|entities|prisma|migrations?|repositories|repo)\//i,
  },
  {
    section: 'middleware',
    label: 'Middleware',
    pattern: /(^|\/)(middlewares?|guards?|interceptors?|filters?|policies|auth)\//i,
  },
  {
    section: 'config',
    label: 'Configuration',
    pattern: /(^|\/)(config|configs|settings|env|constants)\//i,
  },
  {
    section: 'functions',
    label: 'Functions',
    pattern: /(^|\/)(functions?|lambdas?|workers?|jobs?|serverless)\//i,
  },
];

/** Schema files are database material wherever they live. */
const DATABASE_FILE = /\.(sql|prisma)$/i;

const CONFIG_FILE =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|next\.config[^/]*|vite\.config[^/]*|fastify[^/]*\.(ts|js)|dockerfile|docker-compose[^/]*|\.env\.(example|sample|template)|requirements\.txt|composer\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle)$/i;

const SOURCE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|java|kt|cs|rs|sql|prisma|json|toml|ya?ml|env|example|sample|template)$/i;

const LIMIT_PER_SECTION = 24;

export interface ClassifyBackendInput {
  readonly framework: string | null;
  readonly language?: string | null;
  readonly runtime?: string | null;
  readonly files: readonly { readonly path: string; readonly size: number }[];
}

function matchesConfigFile(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return CONFIG_FILE.test(path) || CONFIG_FILE.test(name);
}

/** Classifies one path into a single backend section. */
export function classifyBackendPath(path: string): BackendSectionName {
  if (matchesConfigFile(path)) return 'config';
  if (DATABASE_FILE.test(path)) return 'database';
  for (const rule of RULES) {
    if (rule.pattern.test(path)) return rule.section;
  }
  return 'utilities';
}

function layoutOf(paths: readonly string[]): BackendStructure['layout'] {
  const has = (suffix: string) => paths.some((path) => path.toLowerCase().endsWith(suffix));
  if (has('manage.py') || has('requirements.txt') || has('pyproject.toml')) return 'python';
  if (has('composer.json') || has('artisan')) return 'php';
  if (has('.csproj') || has('.sln')) return 'dotnet';
  if (has('package.json') || has('tsconfig.json')) return 'node';
  return 'neutral';
}

/**
 * Groups backend files and reports honest totals. Files that are not source
 * (images, fonts, lockfiles) are counted in the totals but not in a section.
 */
export function classifyBackendStructure(input: ClassifyBackendInput): BackendStructure {
  const sourceFiles = input.files.filter((file) => SOURCE_EXTENSIONS.test(file.path));
  const buckets = new Map<BackendSectionName, { path: string; size: number }[]>();

  for (const file of sourceFiles) {
    const section = classifyBackendPath(file.path);
    const list = buckets.get(section) ?? [];
    list.push({ path: file.path, size: file.size });
    buckets.set(section, list);
  }

  const totals = input.files.reduce(
    (acc, file) => ({ files: acc.files + 1, bytes: acc.bytes + file.size }),
    { files: 0, bytes: 0 },
  );

  const order: readonly BackendSectionName[] = [
    'routes',
    'services',
    'models',
    'database',
    'middleware',
    'functions',
    'config',
    'utilities',
  ];

  const sections: BackendStructureSection[] = order.map((name) => {
    const files = (buckets.get(name) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    const rule = RULES.find((entry) => entry.section === name);
    const label = name === 'database' ? 'Database' : (rule?.label ?? 'Utilities');
    return {
      section: name,
      label,
      count: files.length,
      files: files.slice(0, LIMIT_PER_SECTION),
      omitted: Math.max(0, files.length - LIMIT_PER_SECTION),
    };
  });

  return {
    layout: layoutOf(sourceFiles.map((file) => file.path)),
    framework: input.framework,
    language: input.language ?? null,
    runtime: input.runtime ?? null,
    totals,
    sections,
  };
}

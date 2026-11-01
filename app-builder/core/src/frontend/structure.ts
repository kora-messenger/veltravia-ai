/**
 * Frontend structure classification (Step 32).
 *
 * The builder UI needs to say "these are your pages, components, layouts…"
 * without pretending every project is a React app and without shipping every
 * file into the browser to guess. So classification is:
 *
 * - path-only: it never reads file contents;
 * - framework-aware: the presentation style comes from detected technology,
 *   and an unknown stack falls back to a neutral grouping rather than a
 *   React-shaped fiction;
 * - total and deterministic: every input file lands in exactly one section,
 *   and identical input always produces identical output.
 *
 * These groups are LOGICAL, not mandatory directories: a file called
 * `DashboardPage.tsx` is a page wherever it lives.
 */

export const FRONTEND_SECTIONS = [
  'pages',
  'components',
  'layouts',
  'hooks',
  'styles',
  'assets',
  'utils',
  'other',
] as const;

export type FrontendSection = (typeof FRONTEND_SECTIONS)[number];

/** How a project's frontend is presented. Derived from the detected stack. */
export type FrontendLayout = 'component-based' | 'flutter' | 'neutral';

export interface FrontendFileInput {
  readonly path: string;
  readonly size?: number;
}

export interface FrontendStructureInput {
  readonly files: readonly FrontendFileInput[];
  /** Registry technology id of the frontend framework, when detection knew one. */
  readonly framework?: string | null;
  /** Hard cap on files listed per section; counts stay complete. */
  readonly perSectionLimit?: number;
}

export interface FrontendSectionSummary {
  readonly section: FrontendSection;
  readonly label: string;
  readonly count: number;
  readonly bytes: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  /** Files in this section omitted from `files` by the per-section limit. */
  readonly omitted: number;
}

export interface FrontendStructure {
  readonly layout: FrontendLayout;
  readonly framework: string | null;
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly sections: readonly FrontendSectionSummary[];
  /** Convenience lists the overview renders directly. */
  readonly pages: readonly string[];
  readonly components: readonly string[];
}

const SECTION_LABELS: Record<FrontendSection, string> = {
  pages: 'Pages',
  components: 'Components',
  layouts: 'Layouts',
  hooks: 'Hooks',
  styles: 'Styles',
  assets: 'Assets',
  utils: 'Utilities',
  other: 'Other files',
};

const COMPONENT_FRAMEWORKS = new Set([
  'react',
  'react-router',
  'nextjs',
  'next',
  'remix',
  'vue',
  'vue-router',
  'nuxt',
  'nuxtjs',
  'svelte',
  'sveltekit',
  'solid',
  'solidjs',
  'angular',
  'preact',
  'astro',
  'qwik',
  'ember',
]);

const FLUTTER_FRAMEWORKS = new Set(['flutter', 'dart']);

const STYLE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss']);
const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mp3',
  'wav',
  'pdf',
]);

/** Upper bound so an enormous repository cannot blow up the response. */
const DEFAULT_PER_SECTION_LIMIT = 200;
const MAX_FILES = 20000;

function extension(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function segments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** True when the path has a segment equal to one of `names` (case-insensitive). */
function inDirectory(path: string, names: readonly string[]): boolean {
  const parts = segments(path)
    .slice(0, -1)
    .map((segment) => segment.toLowerCase());
  return parts.some((segment) => names.includes(segment));
}

function startsWithDirectory(path: string, names: readonly string[]): boolean {
  const first = segments(path)[0]?.toLowerCase() ?? '';
  return names.includes(first);
}

function layoutFor(framework: string | null): FrontendLayout {
  if (framework === null) return 'neutral';
  const id = framework.toLowerCase();
  if (FLUTTER_FRAMEWORKS.has(id)) return 'flutter';
  if (COMPONENT_FRAMEWORKS.has(id)) return 'component-based';
  return 'neutral';
}

function classifyComponentBased(path: string): FrontendSection {
  const name = baseName(path);
  const ext = extension(path);

  if (
    ASSET_EXTENSIONS.has(ext) ||
    startsWithDirectory(path, ['public', 'assets', 'static', 'media'])
  ) {
    return 'assets';
  }
  if (STYLE_EXTENSIONS.has(ext) || inDirectory(path, ['styles', 'style', 'theme', 'themes'])) {
    return 'styles';
  }
  if (inDirectory(path, ['hooks']) || /^use[A-Z0-9].*\.(ts|tsx|js|jsx)$/.test(name)) {
    return 'hooks';
  }
  if (inDirectory(path, ['layouts', 'layout'])) return 'layouts';
  if (
    inDirectory(path, ['pages', 'routes', 'views', 'screens']) ||
    /(^|[._-])page\.(tsx?|jsx?)$/i.test(name) ||
    /Page\.(tsx?|jsx?)$/.test(name) ||
    /\.(page|route)\.(tsx?|jsx?)$/i.test(name)
  ) {
    return 'pages';
  }
  if (
    inDirectory(path, ['components', 'ui', 'widgets']) ||
    /\.(component|view)\.(tsx?|jsx?)$/i.test(name)
  ) {
    return 'components';
  }
  if (inDirectory(path, ['utils', 'util', 'lib', 'libs', 'helpers', 'services', 'api'])) {
    return 'utils';
  }
  return 'other';
}

function classifyFlutter(path: string): FrontendSection {
  const ext = extension(path);
  if (ASSET_EXTENSIONS.has(ext) || startsWithDirectory(path, ['assets', 'images', 'fonts'])) {
    return 'assets';
  }
  if (inDirectory(path, ['pages', 'screens', 'routes'])) return 'pages';
  if (inDirectory(path, ['widgets', 'components'])) return 'components';
  if (inDirectory(path, ['layouts'])) return 'layouts';
  if (inDirectory(path, ['theme', 'themes', 'styles'])) return 'styles';
  if (inDirectory(path, ['utils', 'helpers', 'services', 'models', 'core'])) return 'utils';
  return 'other';
}

function classifyNeutral(path: string): FrontendSection {
  const ext = extension(path);
  if (ASSET_EXTENSIONS.has(ext) || startsWithDirectory(path, ['public', 'assets', 'static'])) {
    return 'assets';
  }
  if (STYLE_EXTENSIONS.has(ext) || inDirectory(path, ['styles', 'theme'])) return 'styles';
  if (inDirectory(path, ['pages', 'views', 'routes', 'screens', 'templates'])) return 'pages';
  if (inDirectory(path, ['components', 'partials', 'widgets'])) return 'components';
  if (inDirectory(path, ['layouts'])) return 'layouts';
  if (inDirectory(path, ['hooks'])) return 'hooks';
  if (inDirectory(path, ['utils', 'lib', 'helpers', 'services'])) return 'utils';
  return 'other';
}

/**
 * Groups a project's files into frontend sections.
 *
 * Nothing here reads or trusts file content: a path is data, not an
 * instruction, and the section it lands in is presentation only.
 */
export function classifyFrontendStructure(input: FrontendStructureInput): FrontendStructure {
  const framework = input.framework ?? null;
  const layout = layoutFor(framework);
  const perSectionLimit = Math.max(1, input.perSectionLimit ?? DEFAULT_PER_SECTION_LIMIT);

  const bySection = new Map<FrontendSection, { path: string; size: number }[]>();
  for (const section of FRONTEND_SECTIONS) bySection.set(section, []);

  let files = 0;
  let bytes = 0;
  for (const file of input.files.slice(0, MAX_FILES)) {
    const path = file.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    const size = typeof file.size === 'number' && file.size >= 0 ? file.size : 0;
    const section =
      layout === 'flutter'
        ? classifyFlutter(path)
        : layout === 'component-based'
          ? classifyComponentBased(path)
          : classifyNeutral(path);
    bySection.get(section)?.push({ path, size });
    files += 1;
    bytes += size;
  }

  const sections: FrontendSectionSummary[] = [];
  for (const section of FRONTEND_SECTIONS) {
    const entries = (bySection.get(section) ?? [])
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));
    const listed = entries.slice(0, perSectionLimit);
    sections.push({
      section,
      label: SECTION_LABELS[section],
      count: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.size, 0),
      files: listed,
      omitted: entries.length - listed.length,
    });
  }

  const pick = (section: FrontendSection): string[] =>
    sections.find((entry) => entry.section === section)?.files.map((file) => file.path) ?? [];

  return {
    layout,
    framework,
    totals: { files, bytes },
    sections,
    pages: pick('pages'),
    components: pick('components'),
  };
}

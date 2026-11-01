/**
 * The language and framework capability registry (Step 30).
 *
 * One rule shapes this module: a technology is a DATA ENTRY, not a branch in
 * the builder. Adding Python 3.14 support, a new package manager, or an
 * entirely new language means adding an entry - never editing the orchestrator.
 *
 * Every entry states its own honesty level (`supportLevel`), its commands as
 * argv arrays (never a shell string), and the capabilities it explicitly does
 * NOT have, so the UI can never promise a build that cannot run.
 */

import { AppBuilderError } from '../errors/index.js';
import { FRAMEWORK_ENTRIES, LANGUAGE_ENTRIES } from './catalog.js';
import {
  isProjectKind,
  isSupportLevel,
  isTechnologyLayer,
  type CommandPlan,
  type FrameworkEntry,
  type LanguageEntry,
  type ProjectKind,
  type RegistryEntry,
  type SupportLevel,
  type TechnologyLayer,
} from '../types/index.js';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVERISH = /^\d+(?:\.\d+){0,2}(?:-[a-z0-9.]+)?$/i;

/** Programs that would smuggle a shell in through argv. */
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const SHELL_FRAGMENTS = ['&&', '||', ';', '|', '$(', '`', '>', '<', '$SHELL'];

/** Obvious credential shapes, rejected so keys never land in the registry. */
const SECRET_SHAPED = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export interface RegistryOptions {
  /** Adds the built-in catalog. Defaults to true. */
  readonly seedCatalog?: boolean;
}

export class LanguageFrameworkRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly version: string;

  constructor(seedCatalog = true) {
    this.version = '1';
    if (seedCatalog) {
      // Imported lazily to keep the data module free of registry logic.
      for (const entry of builtinCatalog()) {
        this.register(entry);
      }
    }
  }

  /** The catalog generation, so a client can tell when entries changed. */
  get catalogVersion(): string {
    return `registry-${this.version}`;
  }

  register(entry: RegistryEntry): void {
    this.assertValidEntry(entry);
    if (this.entries.has(entry.id)) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `a registry entry with id "${entry.id}" already exists`,
        { id: entry.id },
      );
    }
    if (entry.kind === 'framework' && !this.entries.has(entry.languageId)) {
      throw new AppBuilderError(
        'APP_BUILDER_UNKNOWN_TECHNOLOGY',
        `framework "${entry.id}" references unknown language "${entry.languageId}"`,
        { id: entry.id },
      );
    }
    this.entries.set(entry.id, entry);
  }

  /** Registers or replaces an entry - used when a catalog entry is revised. */
  upsert(entry: RegistryEntry): void {
    this.assertValidEntry(entry);
    this.entries.set(entry.id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Resolves an id, or throws a scrubbed not-found error. */
  get(id: string): RegistryEntry {
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        'a technology id must be a short string',
      );
    }
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new AppBuilderError(
        'APP_BUILDER_UNKNOWN_TECHNOLOGY',
        `"${id}" is not in the registry`,
        { id },
      );
    }
    return entry;
  }

  /** Resolves an id without throwing. */
  find(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  list(): readonly RegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  languages(): readonly LanguageEntry[] {
    return this.list().filter((entry): entry is LanguageEntry => entry.kind === 'language');
  }

  frameworks(): readonly FrameworkEntry[] {
    return this.list().filter((entry): entry is FrameworkEntry => entry.kind === 'framework');
  }

  byLayer(layer: TechnologyLayer): readonly RegistryEntry[] {
    return this.list().filter((entry) => entry.layer === layer);
  }

  /** Frameworks that can build a given kind of project. */
  forProjectKind(kind: ProjectKind): readonly FrameworkEntry[] {
    return this.frameworks().filter((entry) => entry.projectKinds.includes(kind));
  }

  frameworksFor(languageId: string): readonly FrameworkEntry[] {
    return this.frameworks().filter((entry) => entry.languageId === languageId);
  }

  supportLevelOf(id: string): SupportLevel {
    return this.get(id).supportLevel;
  }

  /** Whether a version string is one the entry claims. Unknown versions warn, never pass silently. */
  isVersionSupported(id: string, version: string): boolean {
    const entry = this.get(id);
    if (entry.versions.length === 0) return true;
    return entry.versions.includes(version);
  }

  /** The declared build plan, or null when the entry has none. */
  buildPlan(id: string): CommandPlan | null {
    return this.get(id).build ?? null;
  }

  testPlan(id: string): CommandPlan | null {
    return this.get(id).test ?? null;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private assertValidEntry(entry: RegistryEntry): void {
    const fail = (message: string, details: Record<string, unknown> = {}): never => {
      throw new AppBuilderError('APP_BUILDER_INVALID_REQUEST', message, details);
    };

    if (entry.kind !== 'language' && entry.kind !== 'framework') {
      fail('a registry entry must be a language or a framework');
    }
    if (!ID_PATTERN.test(entry.id)) {
      fail(`registry id "${entry.id}" must be lower kebab-case`);
    }
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      fail(`registry entry "${entry.id}" needs a name`);
    }
    this.assertHumanText(entry.id, 'name', entry.name);
    if (!isTechnologyLayer(entry.layer)) {
      fail(`registry entry "${entry.id}" has an unknown layer`);
    }
    if (!isSupportLevel(entry.supportLevel)) {
      fail(`registry entry "${entry.id}" has an unknown support level`);
    }
    for (const version of entry.versions) {
      if (!SEMVERISH.test(version)) {
        fail(`registry entry "${entry.id}" declares a version that is not a version`, { version });
      }
    }
    if (entry.versions.length > 24) {
      fail(`registry entry "${entry.id}" declares too many versions`);
    }
    for (const manager of entry.packageManagers) {
      if (!ID_PATTERN.test(manager.id)) {
        fail(`registry entry "${entry.id}" has an invalid package manager id`);
      }
      this.assertCommandText(entry.id, `${manager.id} install`, manager.installCommand);
      if (manager.manifestFile.includes('..') || manager.manifestFile.startsWith('/')) {
        fail(`registry entry "${entry.id}" has an unsafe manifest path`);
      }
    }
    for (const [label, plan] of [
      ['build', entry.build],
      ['test', entry.test],
    ] as const) {
      if (plan !== undefined && plan !== null) this.assertCommandPlan(entry.id, label, plan);
    }
    if (entry.preview.ports.length > 8) {
      fail(`registry entry "${entry.id}" declares too many preview ports`);
    }
    for (const port of entry.preview.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        fail(`registry entry "${entry.id}" has an invalid preview port`);
      }
    }
    if (!['static', 'server', 'device-emulator', 'none'].includes(entry.preview.mode)) {
      fail(`registry entry "${entry.id}" has an unknown preview mode`);
    }
    if (entry.unsupported.length > 32) {
      fail(`registry entry "${entry.id}" lists too many unsupported capabilities`);
    }
    this.assertHumanText(entry.id, 'preview note', entry.preview.note);
    this.assertHumanText(entry.id, 'deployment note', entry.deployment.note);
    for (const item of entry.unsupported) this.assertHumanText(entry.id, 'unsupported entry', item);
    for (const target of entry.deployment.targets)
      this.assertHumanText(entry.id, 'deployment target', target);
    for (const runtime of entry.runtime.runtimes) {
      // Runtime ids name real binaries (`g++`, `python3`, `dotnet`), so the
      // kebab-case id rule does not apply to them.
      if (!/^[a-z][a-z0-9.+-]{0,31}$/.test(runtime)) {
        fail(`registry entry "${entry.id}" has an invalid runtime id`, { runtime });
      }
    }

    if (entry.kind === 'language') {
      if (entry.layer === 'frontend' && !['frontend', 'systems', 'other'].includes(entry.layer)) {
        fail(`registry entry "${entry.id}" has an inconsistent layer`);
      }
      for (const extension of entry.fileExtensions) {
        if (!/^\.[A-Za-z0-9+#]{1,8}$/.test(extension)) {
          fail(`registry entry "${entry.id}" has an invalid file extension`, { extension });
        }
      }
      for (const manifest of entry.manifestFiles) {
        if (manifest.includes('..') || manifest.startsWith('/')) {
          fail(`registry entry "${entry.id}" has an unsafe manifest path`);
        }
      }
      if (entry.manifestFiles.length > 24 || entry.fileExtensions.length > 24) {
        fail(`registry entry "${entry.id}" declares too many detection signals`);
      }
    } else {
      for (const kind of entry.projectKinds) {
        if (!isProjectKind(kind)) {
          fail(`registry entry "${entry.id}" lists an unknown project kind`, { kind });
        }
      }
      if (entry.projectKinds.length === 0) {
        fail(`framework "${entry.id}" must build at least one project kind`);
      }
      for (const signal of entry.dependencySignals) {
        this.assertHumanText(entry.id, 'dependency signal', signal);
        if (signal.length > 120) fail(`framework "${entry.id}" has an over-long dependency signal`);
      }
    }
  }

  private assertCommandPlan(id: string, label: string, plan: CommandPlan): void {
    if (!Array.isArray(plan.argv) || plan.argv.length === 0 || plan.argv.length > 16) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `"${id}" has an invalid ${label} command`,
        {
          id,
        },
      );
    }
    const program = plan.argv[0];
    if (program === undefined) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `"${id}" has an empty ${label} command`,
        {
          id,
        },
      );
    }
    if (SHELL_PROGRAMS.has(program.toLowerCase())) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `"${id}" tries to run a shell for ${label}; commands are argv arrays only`,
        { id },
      );
    }
    for (const part of plan.argv) {
      if (typeof part !== 'string' || part.length === 0 || part.length > 200) {
        throw new AppBuilderError(
          'APP_BUILDER_INVALID_REQUEST',
          `"${id}" has an invalid ${label} argument`,
          { id },
        );
      }
      for (const fragment of SHELL_FRAGMENTS) {
        if (part.includes(fragment)) {
          throw new AppBuilderError(
            'APP_BUILDER_INVALID_REQUEST',
            `"${id}" has a ${label} argument containing shell syntax`,
            { id },
          );
        }
      }
      this.assertHumanText(id, `${label} argument`, part);
    }
    if (!Number.isInteger(plan.maxSeconds) || plan.maxSeconds < 1 || plan.maxSeconds > 3_600) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `"${id}" has an out-of-range ${label} timeout`,
        { id },
      );
    }
    this.assertHumanText(id, `${label} description`, plan.description);
  }

  private assertCommandText(id: string, label: string, text: string): void {
    if (typeof text !== 'string' || text.length === 0 || text.length > 120) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        `"${id}" has an invalid ${label} command`,
        {
          id,
        },
      );
    }
    for (const fragment of SHELL_FRAGMENTS) {
      if (text.includes(fragment)) {
        throw new AppBuilderError(
          'APP_BUILDER_INVALID_REQUEST',
          `"${id}" has a ${label} command containing shell syntax`,
          { id },
        );
      }
    }
  }

  private assertHumanText(id: string, label: string, text: string): void {
    if (typeof text !== 'string' || text.length > 400) {
      throw new AppBuilderError('APP_BUILDER_INVALID_REQUEST', `"${id}" has an invalid ${label}`, {
        id,
      });
    }
    for (const pattern of SECRET_SHAPED) {
      if (pattern.test(text)) {
        throw new AppBuilderError(
          'APP_BUILDER_SECRET_REJECTED',
          `"${id}" contains something that looks like a credential in its ${label}`,
          { id },
        );
      }
    }
  }
}

/**
 * The built-in catalog. Kept in its own module (below) so the registry stays
 * logic-only and the data is reviewable on its own.
 */
export function builtinCatalog(): readonly RegistryEntry[] {
  return [...LANGUAGE_ENTRIES, ...FRAMEWORK_ENTRIES];
}

/**
 * Technology stack detection (Step 30).
 *
 * Detection answers one question - what is in this project? - from FILE NAMES
 * and MANIFEST TEXT only. It never executes anything, never reads outside the
 * supplied manifest, and never rewrites the user's choices: a detected stack
 * that differs from the requested one is reported as a difference.
 *
 * Confidence is evidence-weighted, so a single stray `.py` file does not
 * outrank a real `requirements.txt` plus a Django import.
 */

import { AppBuilderError } from '../errors/index.js';
import type { LanguageFrameworkRegistry } from '../registry/index.js';
import type {
  DetectedTechnology,
  DetectionEvidence,
  ManifestFile,
  StackDetection,
} from '../types/index.js';

const MAX_FILES = 5_000;
const MAX_MANIFEST_TEXT = 40_000;
const MAX_TOTAL_MANIFEST_BYTES = 400_000;
/** Enough evidence to be certain: a manifest plus a source file, roughly. */
const CONFIDENCE_CEILING = 8;

/** Extensions the registry does not know, so the answer can stay honest. */
const KNOWN_UNREGISTERED: Record<string, string> = {
  '.lua': 'Lua',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.hs': 'Haskell',
  '.scala': 'Scala',
  '.zig': 'Zig',
  '.pl': 'Perl',
  '.r': 'R',
  '.jl': 'Julia',
  '.ml': 'OCaml',
  '.fs': 'F#',
  '.vb': 'Visual Basic',
  '.clj': 'Clojure',
  '.dart.js': 'Dart (generated)',
};

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/** Matches a manifest entry, supporting a leading `*.` suffix glob only. */
function manifestMatches(entry: string, path: string): boolean {
  const name = baseName(path);
  if (entry.startsWith('*.')) {
    return name.toLowerCase().endsWith(entry.slice(1).toLowerCase());
  }
  return name.toLowerCase() === entry.toLowerCase();
}

export interface DetectionOptions {
  /** Text of a manifest file is inspected for dependency signals. */
  readonly readManifestText?: (file: ManifestFile) => string | undefined;
}

export class TechnologyStackDetector {
  private readonly registry: LanguageFrameworkRegistry;

  constructor(registry: LanguageFrameworkRegistry) {
    this.registry = registry;
  }

  /**
   * Inspects a file manifest and returns what the stack appears to be.
   * A bare `unknown` answer is a valid answer: nothing is invented.
   */
  detect(files: readonly ManifestFile[], options: DetectionOptions = {}): StackDetection {
    if (!Array.isArray(files)) {
      throw new AppBuilderError(
        'APP_BUILDER_INVALID_REQUEST',
        'A file manifest is required for detection.',
      );
    }
    if (files.length > MAX_FILES) {
      throw new AppBuilderError(
        'APP_BUILDER_LIMIT_EXCEEDED',
        `Detection accepts at most ${MAX_FILES} files at a time.`,
        { count: files.length },
      );
    }

    const languageEvidence = new Map<string, DetectionEvidence[]>();
    const frameworkEvidence = new Map<string, DetectionEvidence[]>();
    const unknownLanguageFiles = new Map<string, number>();
    let totalManifestBytes = 0;
    let recognisedFileCount = 0;

    const push = (
      target: Map<string, DetectionEvidence[]>,
      id: string,
      evidence: DetectionEvidence,
    ): void => {
      const list = target.get(id) ?? [];
      list.push(evidence);
      target.set(id, list);
    };

    for (const file of files) {
      if (typeof file?.path !== 'string' || file.path.length === 0) continue;
      const path = file.path;
      const name = baseName(path);
      const extension = extensionOf(path);
      let matched = false;

      // -- languages by manifest file ------------------------------------
      for (const language of this.registry.languages()) {
        if (language.manifestFiles.some((entry) => manifestMatches(entry, path))) {
          push(languageEvidence, language.id, {
            signal: 'manifest',
            detail: `found ${name}`,
            weight: 3,
          });
          matched = true;
        }
      }

      // -- languages by extension ----------------------------------------
      if (extension.length > 0) {
        for (const language of this.registry.languages()) {
          if (!language.fileExtensions.includes(extension)) continue;
          push(languageEvidence, language.id, {
            signal: 'extension',
            detail: `source file ${extension}`,
            weight: 1,
          });
          matched = true;
          break;
        }
        if (!matched) {
          const unregistered = KNOWN_UNREGISTERED[extension];
          if (unregistered !== undefined) {
            unknownLanguageFiles.set(
              unregistered,
              (unknownLanguageFiles.get(unregistered) ?? 0) + 1,
            );
          }
        }
      }

      // -- frameworks by manifest / config file --------------------------
      for (const framework of this.registry.frameworks()) {
        if (framework.manifestFiles.some((entry) => manifestMatches(entry, path))) {
          push(frameworkEvidence, framework.id, {
            signal: 'config',
            detail: `found ${name}`,
            weight: 3,
          });
          matched = true;
        }
      }

      // -- frameworks by declared dependency ----------------------------
      const text = file.text ?? options.readManifestText?.(file);
      if (typeof text === 'string' && text.length > 0) {
        const clipped = text.length > MAX_MANIFEST_TEXT ? text.slice(0, MAX_MANIFEST_TEXT) : text;
        if (totalManifestBytes + clipped.length <= MAX_TOTAL_MANIFEST_BYTES) {
          totalManifestBytes += clipped.length;
          const lower = clipped.toLowerCase();
          for (const framework of this.registry.frameworks()) {
            for (const signal of framework.dependencySignals) {
              if (!lower.includes(signal.toLowerCase())) continue;
              push(frameworkEvidence, framework.id, {
                signal: 'dependency',
                detail: `${name} mentions ${signal}`,
                weight: 3,
              });
              break;
            }
          }
          // package.json alone also proves a JavaScript/TypeScript family.
          const scripts = /"scripts"\s*:/.test(clipped);
          const typescript = /"typescript"\s*:/.test(clipped) || /"ts-node"\s*:/.test(clipped);
          if (typescript) {
            push(languageEvidence, 'typescript', {
              signal: 'dependency',
              detail: `${name} declares typescript`,
              weight: 3,
            });
          }
          if (scripts && !languageEvidence.has('javascript')) {
            push(languageEvidence, 'javascript', {
              signal: 'manifest',
              detail: `${name} declares scripts`,
              weight: 2,
            });
          }
        }
      }

      if (matched) recognisedFileCount += 1;
    }

    const toDetected = (
      source: Map<string, DetectionEvidence[]>,
      kind: 'language' | 'framework',
    ): DetectedTechnology[] => {
      const out: DetectedTechnology[] = [];
      for (const [id, evidence] of source) {
        const entry = this.registry.find(id);
        if (entry === undefined) continue;
        const weight = evidence.reduce((sum, item) => sum + item.weight, 0);
        const confidence = Math.min(1, Number((weight / CONFIDENCE_CEILING).toFixed(2)));
        if (confidence < 0.1) continue;
        out.push({
          id: entry.id,
          name: entry.name,
          kind,
          layer: entry.layer,
          confidence,
          supportLevel: entry.supportLevel,
          evidence: evidence.slice(0, 8),
        });
      }
      return out.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
    };

    const languages = toDetected(languageEvidence, 'language');
    const frameworks = toDetected(frameworkEvidence, 'framework');

    // A framework implies its language, at the framework's confidence or the
    // language's own, whichever is stronger - but only when it is not already
    // present from direct evidence.
    for (const framework of frameworks) {
      const entry = this.registry.find(framework.id);
      if (entry === undefined || entry.kind !== 'framework') continue;
      if (languages.some((language) => language.id === entry.languageId)) continue;
      const languageEntry = this.registry.find(entry.languageId);
      if (languageEntry === undefined) continue;
      languages.push({
        id: languageEntry.id,
        name: languageEntry.name,
        kind: 'language',
        layer: languageEntry.layer,
        confidence: framework.confidence,
        supportLevel: languageEntry.supportLevel,
        evidence: [
          {
            signal: 'implied',
            detail: `${framework.name} is built on ${languageEntry.name}`,
            weight: 2,
          },
        ],
      });
    }
    languages.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));

    const unknownLanguages = [...unknownLanguageFiles.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    const notes: string[] = [];
    if (files.length === 0) {
      notes.push('There were no files to inspect, so nothing was detected.');
    }
    if (unknownLanguages.length > 0) {
      notes.push(
        `Files for ${unknownLanguages.join(', ')} were found, but those languages are not in the registry, so they are reported rather than planned.`,
      );
    }
    const planned = [...frameworks, ...languages]
      .filter((item) => item.supportLevel === 'planned')
      .map((item) => item.name);
    if (planned.length > 0) {
      notes.push(
        `Detected ${[...new Set(planned)].join(', ')}, which the platform can name but cannot yet build.`,
      );
    }

    return {
      projects: [
        ...frameworks,
        ...languages.filter((language) => !frameworks.some((f) => f.id === language.id)),
      ],
      languages,
      frameworks,
      unrecognisedFiles: Math.max(0, files.length - recognisedFileCount),
      unknownLanguages,
      notes,
    };
  }
}

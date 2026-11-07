/**
 * Project verification discovery - Step 45.
 *
 * Reads what a project actually declares and turns it into the operations it
 * can really perform. The rule that matters: when configuration does not
 * support an operation, it is listed as unsupported with the reason, never
 * invented as a command that will fail in a confusing way.
 */

import type {
  DetectionConfidence,
  PackageManager,
  ProjectFile,
  TestFramework,
  UnsupportedOperation,
  VerificationCommand,
  VerificationOperation,
  VerificationProfile,
} from './types.js';

interface PackageJson {
  readonly name?: string;
  readonly packageManager?: string;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function file(files: readonly ProjectFile[], path: string): ProjectFile | undefined {
  return files.find((candidate) => candidate.path === path);
}

function has(files: readonly ProjectFile[], path: string): boolean {
  return file(files, path) !== undefined;
}

/** Finds a config file at the root or one level down (app/, packages/*). */
function findConfig(files: readonly ProjectFile[], pattern: RegExp): string | null {
  for (const candidate of files) {
    if (pattern.test(candidate.path)) return candidate.path;
  }
  return null;
}

function dependenciesOf(pkg: PackageJson): Record<string, string> {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
}

export function detectPackageManager(
  files: readonly ProjectFile[],
  pkg: PackageJson | null,
): { packageManager: PackageManager; evidence: string | null } {
  const declared = pkg?.packageManager?.split('@')[0]?.trim();
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
    return { packageManager: declared, evidence: 'package.json#packageManager' };
  }
  if (has(files, 'pnpm-lock.yaml')) return { packageManager: 'pnpm', evidence: 'pnpm-lock.yaml' };
  if (has(files, 'yarn.lock')) return { packageManager: 'yarn', evidence: 'yarn.lock' };
  if (has(files, 'bun.lockb')) return { packageManager: 'bun', evidence: 'bun.lockb' };
  if (has(files, 'package-lock.json')) {
    return { packageManager: 'npm', evidence: 'package-lock.json' };
  }
  if (has(files, 'package.json')) return { packageManager: 'npm', evidence: 'package.json' };
  return { packageManager: 'unknown', evidence: null };
}

function scriptRunner(pm: PackageManager): { command: string; prefix: readonly string[] } {
  switch (pm) {
    case 'pnpm':
      return { command: 'pnpm', prefix: ['run'] };
    case 'yarn':
      return { command: 'yarn', prefix: [] };
    case 'bun':
      return { command: 'bun', prefix: ['run'] };
    case 'npm':
    case 'unknown':
      return { command: 'npm', prefix: ['run'] };
  }
}

function scriptCommand(
  pm: PackageManager,
  name: string,
  operation: VerificationOperation,
): VerificationCommand {
  const runner = scriptRunner(pm);
  const quiet = pm === 'npm' || pm === 'unknown' ? ['--silent'] : [];
  return {
    id: `${pm}:${name}`,
    operation,
    command: runner.command,
    args: [...runner.prefix, name, ...quiet],
    source: 'script',
    label: `${pm} run ${name}`,
    confidence: 'high',
    acceptsPath: false,
  };
}

function toolCommand(
  id: string,
  operation: VerificationOperation,
  command: string,
  args: readonly string[],
  label: string,
  confidence: DetectionConfidence,
): VerificationCommand {
  return { id, operation, command, args, source: 'tool', label, confidence, acceptsPath: false };
}

const SCRIPT_ALIASES: Readonly<Record<VerificationOperation, readonly string[]>> = {
  unit: ['test:unit', 'test', 'unit'],
  integration: ['test:integration', 'integration', 'test:int'],
  e2e: ['test:e2e', 'e2e', 'test:e2e:ci'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'check:types'],
  lint: ['lint', 'lint:ci', 'eslint'],
  format: ['format:check', 'prettier:check', 'format'],
  build: ['build', 'build:prod', 'compile'],
  deps: ['deps:check', 'validate:deps'],
};

const OPERATION_LABELS: Readonly<Record<VerificationOperation, string>> = {
  unit: 'unit tests',
  integration: 'integration tests',
  e2e: 'end-to-end tests',
  typecheck: 'type check',
  lint: 'lint',
  format: 'formatting check',
  build: 'production build',
  deps: 'dependency validation',
};

/**
 * Detects the verification profile of a project from its files.
 *
 * Deterministic: same files in, same profile out. No network, no execution.
 */
export function detectVerificationProfile(files: readonly ProjectFile[]): VerificationProfile {
  const packageFile = file(files, 'package.json');
  const parsed = packageFile === undefined ? null : parseJson(packageFile.content);
  const pkg = parsed as PackageJson | null;
  const scripts = pkg?.scripts ?? {};
  const deps = dependenciesOf(pkg ?? {});
  const { packageManager, evidence: pmEvidence } = detectPackageManager(files, pkg);
  const detectedFrom: string[] = [];
  if (packageFile !== undefined) detectedFrom.push('package.json');
  if (pmEvidence !== null && pmEvidence !== 'package.json') detectedFrom.push(pmEvidence);

  const testFrameworks: TestFramework[] = [];
  const frameworkEvidence: string[] = [];
  const addFramework = (name: TestFramework, evidencePath: string): void => {
    if (!testFrameworks.includes(name)) {
      testFrameworks.push(name);
      frameworkEvidence.push(evidencePath);
    }
  };
  if (deps['vitest'] !== undefined || findConfig(files, /(^|\/)vitest\.config\.[cm]?[jt]s$/)) {
    addFramework('vitest', 'vitest');
  }
  if (deps['jest'] !== undefined || findConfig(files, /(^|\/)jest\.config\.[cm]?[jt]s$/)) {
    addFramework('jest', 'jest');
  }
  if (
    deps['@playwright/test'] !== undefined ||
    findConfig(files, /(^|\/)playwright\.config\.[cm]?[jt]s$/)
  ) {
    addFramework('playwright', '@playwright/test');
  }
  if (deps['mocha'] !== undefined || findConfig(files, /(^|\/)\.mocharc\.[cm]?[jt]s$/)) {
    addFramework('mocha', 'mocha');
  }
  if (scripts['test']?.includes('node --test') === true) addFramework('node-test', 'package.json');
  detectedFrom.push(...new Set(frameworkEvidence));

  const tsconfigPath = findConfig(files, /(^|\/)tsconfig(\..+)?\.json$/);
  const eslintPath = findConfig(
    files,
    /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[cm]?[jt]s|\.json)?)$/,
  );
  const prettierPath = findConfig(
    files,
    /(^|\/)(\.prettierrc(\.[cm]?[jt]s|\.json)?|prettier\.config\.[cm]?[jt]s)$/,
  );
  if (tsconfigPath !== null) detectedFrom.push(tsconfigPath);
  if (eslintPath !== null) detectedFrom.push(eslintPath);
  if (prettierPath !== null) detectedFrom.push(prettierPath);

  const hasTestFramework = testFrameworks.length > 0;
  const commands: VerificationCommand[] = [];
  const unsupported: UnsupportedOperation[] = [];
  const missing = new Set<string>();

  const fromScript = (operation: VerificationOperation): VerificationCommand | null => {
    for (const alias of SCRIPT_ALIASES[operation]) {
      if (scripts[alias] !== undefined) {
        const command = scriptCommand(packageManager, alias, operation);
        const acceptsPath =
          (operation === 'unit' || operation === 'integration' || operation === 'e2e') &&
          (testFrameworks.includes('vitest') ||
            testFrameworks.includes('jest') ||
            testFrameworks.includes('playwright'));
        return {
          ...command,
          acceptsPath: acceptsPath && (packageManager === 'npm' || packageManager === 'pnpm'),
        };
      }
    }
    return null;
  };

  for (const operation of [
    'unit',
    'integration',
    'e2e',
    'typecheck',
    'lint',
    'format',
    'build',
    'deps',
  ] as const) {
    const declared = fromScript(operation);
    if (declared !== null) {
      commands.push(declared);
      continue;
    }
    // No script: only offer a tool command the configuration actually supports.
    if (operation === 'typecheck' && tsconfigPath !== null && deps['typescript'] !== undefined) {
      commands.push(
        toolCommand(
          'tool:tsc',
          'typecheck',
          'npx',
          ['tsc', '--noEmit', '--pretty', 'false'],
          'tsc --noEmit',
          'medium',
        ),
      );
      continue;
    }
    if (operation === 'lint' && eslintPath !== null && deps['eslint'] !== undefined) {
      commands.push(
        toolCommand(
          'tool:eslint',
          'lint',
          'npx',
          ['eslint', '.', '--max-warnings', '0'],
          'eslint .',
          'medium',
        ),
      );
      continue;
    }
    if (operation === 'format' && prettierPath !== null && deps['prettier'] !== undefined) {
      commands.push(
        toolCommand(
          'tool:prettier',
          'format',
          'npx',
          ['prettier', '--check', '.'],
          'prettier --check .',
          'medium',
        ),
      );
      continue;
    }
    if (operation === 'deps' && packageManager !== 'unknown') {
      const args =
        packageManager === 'npm'
          ? ['ls', '--depth=0']
          : packageManager === 'pnpm'
            ? ['list', '--depth=0']
            : packageManager === 'yarn'
              ? ['list', '--depth=0']
              : ['pm', 'ls'];
      commands.push(
        toolCommand(
          `tool:${packageManager}-deps`,
          'deps',
          packageManager === 'bun' ? 'bun' : packageManager,
          args,
          `${packageManager} dependency tree`,
          'low',
        ),
      );
      continue;
    }

    const reason =
      operation === 'unit' || operation === 'integration' || operation === 'e2e'
        ? hasTestFramework
          ? `no ${operation} script is declared in package.json`
          : 'no test framework or test script was found in this project'
        : `${OPERATION_LABELS[operation]} is not configured in this project`;
    unsupported.push({ operation, reason });
    if (packageFile === undefined) missing.add('package.json');
    if (operation === 'typecheck' && tsconfigPath === null) missing.add('tsconfig.json');
    if (operation === 'lint' && eslintPath === null) missing.add('eslint config');
    if (operation === 'format' && prettierPath === null) missing.add('prettier config');
  }

  const framework = detectApplicationFramework(deps, files);
  const hasDeclaredScript = commands.some((command) => command.source === 'script');
  const confidence: DetectionConfidence =
    packageFile === undefined
      ? 'none'
      : hasDeclaredScript
        ? 'high'
        : commands.length > 0
          ? 'medium'
          : 'low';

  return {
    framework,
    packageManager,
    scripts,
    testFrameworks,
    commands,
    unsupported,
    confidence,
    detectedFrom,
    missing: [...missing],
  };
}

const APPLICATION_FRAMEWORKS: readonly [string, readonly string[]][] = [
  ['next', ['next']],
  ['nuxt', ['nuxt']],
  ['remix', ['@remix-run/react']],
  ['expo', ['expo']],
  ['react-native', ['react-native']],
  ['react', ['react']],
  ['vue', ['vue']],
  ['svelte', ['svelte']],
  ['angular', ['@angular/core']],
  ['nestjs', ['@nestjs/core']],
  ['fastify', ['fastify']],
  ['express', ['express']],
  ['prisma', ['prisma', '@prisma/client']],
  ['django', []],
  ['flutter', []],
];

function detectApplicationFramework(
  deps: Readonly<Record<string, string>>,
  files: readonly ProjectFile[],
): string | null {
  for (const [name, packages] of APPLICATION_FRAMEWORKS) {
    if (packages.some((dep) => deps[dep] !== undefined)) return name;
  }
  if (has(files, 'manage.py')) return 'django';
  if (has(files, 'pubspec.yaml')) return 'flutter';
  return null;
}

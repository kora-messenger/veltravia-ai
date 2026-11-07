/**
 * Command policy - Step 45.
 *
 * A model never writes a command. It asks for an OPERATION ("unit", "lint"),
 * and this module resolves that operation to one exact argv that a project
 * configuration declared. Everything here is a refusal path first: unknown
 * operations, commands off the allowlist, shell interpreters, injected
 * arguments and paths that try to leave the project are all refused by name.
 */

import type {
  BlockedOperation,
  VerificationCommand,
  VerificationLimits,
  VerificationOperation,
  VerificationProfile,
} from './types.js';
import { VERIFICATION_OPERATIONS } from './types.js';

/**
 * Executables a verification command may name. Package managers are here
 * because running a declared script is the whole point of discovery; each one
 * is still invoked without a shell and with fixed arguments.
 */
export const ALLOWED_EXECUTABLES: readonly string[] = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'playwright',
  'mocha',
  'next',
  'vite',
  'prisma',
];

/** Always refused, whatever else is allowlisted. */
export const DENIED_EXECUTABLES: readonly string[] = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'fish',
  'perl',
  'ruby',
  'php',
  'make',
  'docker',
  'kubectl',
  'ssh',
  'scp',
  'curl',
  'wget',
  'nc',
  'sudo',
  'su',
  'env',
  'xargs',
  'eval',
  'rm',
  'mv',
  'cp',
  'dd',
  'chmod',
  'chown',
];

/** Characters that only make sense to a shell. None may survive into an argv. */
const SHELL_METACHARACTERS = /[;&|`$><\n\r\0*?{}[\]()!~^]/;

const MAX_ARGUMENT_LENGTH = 200;
const MAX_ARGUMENTS = 24;

export interface CommandRefusal {
  readonly code:
    | 'COMMAND_NOT_ALLOWED'
    | 'COMMAND_DENIED'
    | 'ARGUMENT_INVALID'
    | 'PATH_INVALID'
    | 'OPERATION_UNKNOWN';
  readonly message: string;
}

export type CommandValidation =
  { readonly ok: true } | { readonly ok: false; readonly refusal: CommandRefusal };

/** Validates one resolved command. Applied to every command, always. */
export function validateVerificationCommand(command: VerificationCommand): CommandValidation {
  const name = command.command;
  if (DENIED_EXECUTABLES.includes(name)) {
    return {
      ok: false,
      refusal: { code: 'COMMAND_DENIED', message: `The executable "${name}" is never permitted.` },
    };
  }
  if (!ALLOWED_EXECUTABLES.includes(name)) {
    return {
      ok: false,
      refusal: {
        code: 'COMMAND_NOT_ALLOWED',
        message: `The executable "${name}" is not on the verification allowlist.`,
      },
    };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return {
      ok: false,
      refusal: {
        code: 'COMMAND_NOT_ALLOWED',
        message: 'A command must be a bare executable name, never a path.',
      },
    };
  }
  if (command.args.length > MAX_ARGUMENTS) {
    return {
      ok: false,
      refusal: { code: 'ARGUMENT_INVALID', message: 'Too many arguments for one command.' },
    };
  }
  for (const argument of command.args) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_LENGTH) {
      return {
        ok: false,
        refusal: { code: 'ARGUMENT_INVALID', message: 'An argument is too long to accept.' },
      };
    }
    if (SHELL_METACHARACTERS.test(argument)) {
      return {
        ok: false,
        refusal: {
          code: 'ARGUMENT_INVALID',
          message: `The argument "${argument.slice(0, 40)}" contains shell metacharacters.`,
        },
      };
    }
    if (argument.startsWith('/') || /^[A-Za-z]:\\/.test(argument)) {
      return {
        ok: false,
        refusal: {
          code: 'PATH_INVALID',
          message: 'An absolute path may never be passed to a verification command.',
        },
      };
    }
  }
  return { ok: true };
}

/** A path filter must stay inside the project. */
export function validatePathFilter(path: string | undefined): CommandValidation {
  if (path === undefined) return { ok: true };
  if (path.trim() === '' || path.length > 300) {
    return { ok: false, refusal: { code: 'PATH_INVALID', message: 'That path is not usable.' } };
  }
  if (path.startsWith('/') || /^[A-Za-z]:\\/.test(path) || path.includes('\\')) {
    return {
      ok: false,
      refusal: { code: 'PATH_INVALID', message: 'Only project-relative paths are accepted.' },
    };
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    return {
      ok: false,
      refusal: { code: 'PATH_INVALID', message: 'Traversal outside the project is refused.' },
    };
  }
  if (SHELL_METACHARACTERS.test(path)) {
    return {
      ok: false,
      refusal: {
        code: 'PATH_INVALID',
        message: 'The path contains characters a command must not receive.',
      },
    };
  }
  return { ok: true };
}

export interface VerificationPlan {
  /** Commands that will run, in order, each validated. */
  readonly commands: readonly VerificationCommand[];
  /** Operations that will not run, each with a reason the caller can read. */
  readonly blocked: readonly BlockedOperation[];
}

export interface PlanInput {
  readonly profile: VerificationProfile;
  /** Operations the caller asked for. Unknown ids are refused, not ignored. */
  readonly requested: readonly string[];
  /** Operations a worker's assignment authorizes; null means "no assignment". */
  readonly authorized: readonly VerificationOperation[] | null;
  readonly limits: Pick<VerificationLimits, 'maxOperations'>;
  /** Optional path filter, applied to operations whose command accepts one. */
  readonly path?: string | undefined;
}

/**
 * Resolves requested operations into the exact commands that will run.
 *
 * Order: unknown operation -> not in profile -> not authorized -> over the
 * operation limit. Everything refused appears in `blocked`, so a caller sees
 * the difference between "you may not" and "this project has no tests".
 */
export function planVerification(input: PlanInput): VerificationPlan {
  const blocked: BlockedOperation[] = [];
  const selected: VerificationCommand[] = [];
  const seen = new Set<VerificationOperation>();

  for (const requested of input.requested) {
    if (!(VERIFICATION_OPERATIONS as readonly string[]).includes(requested)) {
      blocked.push({
        operation: requested as VerificationOperation,
        reason: 'not_in_profile',
        detail: `"${requested}" is not a verification operation this platform knows.`,
      });
      continue;
    }
    const operation = requested as VerificationOperation;
    if (seen.has(operation)) continue;
    seen.add(operation);

    const command = input.profile.commands.find((candidate) => candidate.operation === operation);
    if (command === undefined) {
      const unsupported = input.profile.unsupported.find((entry) => entry.operation === operation);
      blocked.push({
        operation,
        reason: 'not_in_profile',
        detail: unsupported?.reason ?? `This project has no ${operation} command.`,
      });
      continue;
    }
    if (input.authorized !== null && !input.authorized.includes(operation)) {
      blocked.push({
        operation,
        reason: 'not_authorized',
        detail: `The assignment does not authorize ${operation} verification.`,
      });
      continue;
    }
    if (selected.length >= input.limits.maxOperations) {
      blocked.push({
        operation,
        reason: 'limit_reached',
        detail: `This run may execute at most ${input.limits.maxOperations} operations.`,
      });
      continue;
    }

    const validation = validateVerificationCommand(command);
    if (!validation.ok) {
      blocked.push({
        operation,
        reason: 'not_in_profile',
        detail: validation.refusal.message,
      });
      continue;
    }

    if (input.path !== undefined && command.acceptsPath) {
      const pathValidation = validatePathFilter(input.path);
      if (!pathValidation.ok) {
        blocked.push({
          operation,
          reason: 'not_in_profile',
          detail: pathValidation.refusal.message,
        });
        continue;
      }
      selected.push({
        ...command,
        args: [...command.args, '--', input.path],
        label: `${command.label} ${input.path}`,
      });
      continue;
    }
    selected.push(command);
  }

  return { commands: selected, blocked };
}

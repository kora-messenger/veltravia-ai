/**
 * Command policy - allowlist-first, hard denylist, no shells.
 *
 * Untrusted code is executed ONLY as a structured executable + arguments
 * pair, never through `sh -c` / `bash -c` / `cmd /c` / `powershell`.
 * A command is allowed only when ALL of these hold:
 *
 *   1. it is a plain executable name (no paths, no metacharacters)
 *   2. it is NOT on the hard denylist (denylist wins over any allowlist)
 *   3. it IS on the sandbox profile's allowlist
 *   4. it is not a shell interpreter, unless an explicitly reviewed shell
 *      policy exists (allowShellExecution - Step 8 never enables it)
 */

import { CommandNotAllowedError, InvalidSandboxRequestError } from '../errors/index.js';

/**
 * Commands that are ALWAYS denied, even if a profile allowlists them.
 * Defense in depth: profiles are data; this list is code.
 */
export const HARD_DENIED_COMMANDS: readonly string[] = [
  'rm',
  'rmdir',
  'mkfs',
  'dd',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'mount',
  'umount',
  'kill',
  'pkill',
  'killall',
  'sudo',
  'su',
  'doas',
  'passwd',
  'chpasswd',
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'chmod',
  'chown',
  'chgrp',
  'setuid-capable',
  'nsenter',
  'unshare',
  'systemctl',
  'service',
  'crontab',
  'at',
  'env',
  'setarch',
  'ptrace',
];

/** Shell interpreters - denied unless an explicit reviewed policy allows them. */
export const SHELL_COMMANDS: readonly string[] = [
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'ash',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
];

/** Valid executable names: letters, digits, dots, dashes, underscores. */
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const COMMAND_MAX_LENGTH = 64;
/* eslint-disable no-control-regex -- rejecting control characters is the entire
   point of this pattern. */
const CONTROL_PATTERN = /[\x00-\x1f\u007f]/;
/* eslint-enable no-control-regex */
/** Shell metacharacters that mark a "command string" (never accepted). */
const SHELL_METACHARACTER_PATTERN = /[;&|`$><\n]/;

/** A valid executable name, or a typed rejection. */
export function validateCommandName(command: string): string {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new InvalidSandboxRequestError('command must be a non-empty string', {
      reason: 'empty',
    });
  }
  if (command.length > COMMAND_MAX_LENGTH) {
    throw new InvalidSandboxRequestError('command is too long', { reason: 'too-long' });
  }
  if (CONTROL_PATTERN.test(command)) {
    throw new InvalidSandboxRequestError('command contains control characters', {
      reason: 'control-character',
    });
  }
  if (command.includes('/') || command.includes('\\')) {
    // Reject "bin/sh", "./tool", "C:\tool" - executable NAMES only, so the
    // runtime resolves them inside the isolation boundary, never on the host.
    throw new CommandNotAllowedError(command, 'executable names must not contain path separators');
  }
  if (SHELL_METACHARACTER_PATTERN.test(command)) {
    throw new CommandNotAllowedError(
      command,
      'shell metacharacters are rejected - structured execution only (no sh -c, no chaining, no substitution)',
    );
  }
  if (!COMMAND_NAME_PATTERN.test(command)) {
    throw new InvalidSandboxRequestError('command is not a valid executable name', {
      reason: 'invalid-name',
    });
  }
  if (command.includes('..')) {
    throw new CommandNotAllowedError(command, 'executable names must not contain ".."');
  }
  return command;
}

/** Full policy check for one execution. Throws CommandNotAllowedError. */
export function assertCommandAllowed(
  command: string,
  policy: { allowedCommands: readonly string[]; allowShellExecution: boolean },
): void {
  const name = validateCommandName(command);
  const lower = name.toLowerCase();
  if (HARD_DENIED_COMMANDS.includes(lower)) {
    throw new CommandNotAllowedError(name, 'the command is on the hard denylist');
  }
  if (SHELL_COMMANDS.includes(lower) && !policy.allowShellExecution) {
    throw new CommandNotAllowedError(
      name,
      'shell interpreters are denied - structured execution only (allowShellExecution is false)',
    );
  }
  if (!policy.allowShellExecution && SHELL_COMMANDS.includes(lower)) {
    // Unreachable duplicate kept for clarity of the audit trail.
    throw new CommandNotAllowedError(name, 'shell execution is disabled');
  }
  if (!policy.allowedCommands.some((allowed) => allowed.toLowerCase() === lower)) {
    throw new CommandNotAllowedError(name, 'the command is not on the sandbox profile allowlist');
  }
}

/**
 * Argument validation. Arguments are passed WITHOUT a shell, so shell
 * syntax inside them is inert data - but control characters and host-path
 * attempts are still rejected at the boundary (the runtime filesystem view
 * enforces the workspace boundary again inside).
 */
const ARGUMENT_MAX_LENGTH = 4096;
const ARGUMENT_MAX_COUNT = 64;

export function validateArguments(args: readonly unknown[]): string[] {
  if (!Array.isArray(args)) {
    throw new InvalidSandboxRequestError('arguments must be an array of strings', {
      reason: 'not-an-array',
    });
  }
  if (args.length > ARGUMENT_MAX_COUNT) {
    throw new InvalidSandboxRequestError(
      `arguments must not exceed ${ARGUMENT_MAX_COUNT} entries`,
      {
        reason: 'too-many',
      },
    );
  }
  return args.map((argument, index) => {
    if (typeof argument !== 'string') {
      throw new InvalidSandboxRequestError(`arguments[${index}] must be a string`, {
        index,
        reason: 'not-a-string',
      });
    }
    if (argument.length > ARGUMENT_MAX_LENGTH) {
      throw new InvalidSandboxRequestError(`arguments[${index}] is too long`, {
        index,
        reason: 'too-long',
      });
    }
    if (CONTROL_PATTERN.test(argument)) {
      throw new InvalidSandboxRequestError(`arguments[${index}] contains control characters`, {
        index,
        reason: 'control-character',
      });
    }
    return argument;
  });
}

/**
 * Validates a profile-level allowlist. Profiles are rejected at CREATION
 * time if they contain denied/shell/path-like commands - so no sandbox can
 * ever exist with a dangerous allowlist.
 */
export function validateCommandPolicy(policy: {
  allowedCommands: readonly string[];
  allowShellExecution: boolean;
}): { allowedCommands: string[]; allowShellExecution: boolean } {
  if (typeof policy.allowShellExecution !== 'boolean') {
    throw new InvalidSandboxRequestError('allowShellExecution must be a boolean', {
      reason: 'not-a-boolean',
    });
  }
  if (!Array.isArray(policy.allowedCommands) || policy.allowedCommands.length === 0) {
    throw new InvalidSandboxRequestError(
      'allowedCommands must be a non-empty array - an empty allowlist denies everything and is rejected as a misconfiguration',
      { reason: 'empty' },
    );
  }
  const normalized: string[] = [];
  for (const entry of policy.allowedCommands) {
    if (typeof entry !== 'string') {
      throw new InvalidSandboxRequestError('allowedCommands entries must be strings', {
        reason: 'not-a-string',
      });
    }
    const name = validateCommandName(entry);
    const lower = name.toLowerCase();
    if (HARD_DENIED_COMMANDS.includes(lower)) {
      throw new InvalidSandboxRequestError(
        `allowedCommands contains hard-denied command "${name}"`,
        { reason: 'denied-command' },
      );
    }
    if (SHELL_COMMANDS.includes(lower) && !policy.allowShellExecution) {
      throw new InvalidSandboxRequestError(
        `allowedCommands contains shell "${name}" but allowShellExecution is false`,
        { reason: 'shell-without-policy' },
      );
    }
    if (!normalized.includes(name)) {
      normalized.push(name);
    }
  }
  return { allowedCommands: normalized, allowShellExecution: policy.allowShellExecution };
}

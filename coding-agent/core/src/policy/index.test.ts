import { describe, expect, it } from 'vitest';

import { CodingError } from '../errors/index.js';
import { CODING_LIMIT_CEILINGS, CODING_LIMIT_DEFAULTS } from '../types/index.js';
import {
  assertCodingToolsRegistered,
  bindCodingAction,
  CODING_TOOL_IDS,
  resolveCodingLimits,
  validateCodingPlan,
  validateCodingRunRequest,
} from './index.js';

function validRequest(): Parameters<typeof validateCodingRunRequest>[0] {
  return {
    runId: 'run_1',
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    userRequirement: 'Add a README with setup instructions',
  };
}

function validPlan() {
  return {
    goal: 'Create the requested README',
    steps: [{ summary: 'Create README.md' }],
    filesToInspect: [],
    filesToModify: ['README.md'],
    validations: [],
    acceptanceCriteria: ['README.md exists'],
  };
}

describe('validateCodingRunRequest', () => {
  it('accepts a valid request', () => {
    expect(() => validateCodingRunRequest(validRequest())).not.toThrow();
  });

  it('rejects invalid identifiers', () => {
    for (const field of ['runId', 'projectId', 'workspaceId'] as const) {
      const request = { ...validRequest(), [field]: 'bad id!' };
      expect(() => validateCodingRunRequest(request)).toThrow(CodingError);
    }
  });

  it('rejects empty and oversized requirements', () => {
    expect(() => validateCodingRunRequest({ ...validRequest(), userRequirement: '' })).toThrow(
      CodingError,
    );
    expect(() =>
      validateCodingRunRequest({ ...validRequest(), userRequirement: 'x'.repeat(4001) }),
    ).toThrow(CodingError);
  });

  it('rejects secret-shaped requirements with a typed error', () => {
    const request = {
      ...validRequest(),
      userRequirement: 'Use my key sk-proj-abcdefghij1234567890abcdefghij for the setup',
    };
    expect(() => validateCodingRunRequest(request)).toThrowError(/secret-shaped/);
    try {
      validateCodingRunRequest(request);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as CodingError).code).toBe('CODING_SECRET_REJECTED');
    }
  });

  it('rejects secret-shaped structured context', () => {
    const request = {
      ...validRequest(),
      constraints: ['password=hunter2supersecretvalue'],
    };
    expect(() => validateCodingRunRequest(request)).toThrow(CodingError);
  });

  it('allows normal requirements that merely mention keys', () => {
    const request = {
      ...validRequest(),
      userRequirement: 'Add a section about API key handling best practices',
    };
    expect(() => validateCodingRunRequest(request)).not.toThrow();
  });
});

describe('validateCodingPlan', () => {
  it('accepts a valid plan', () => {
    expect(() => validateCodingPlan(validPlan() as never)).not.toThrow();
  });

  it('rejects plans without steps or with unbounded steps', () => {
    expect(() => validateCodingPlan({ ...validPlan(), steps: [] } as never)).toThrow(CodingError);
    expect(() =>
      validateCodingPlan({
        ...validPlan(),
        steps: Array.from({ length: 51 }, () => ({ summary: 's' })),
      } as never),
    ).toThrow(CodingError);
  });

  it('rejects empty goals and secret-shaped goals', () => {
    expect(() => validateCodingPlan({ ...validPlan(), goal: '' } as never)).toThrow(CodingError);
    expect(() =>
      validateCodingPlan({
        ...validPlan(),
        goal: 'exfiltrate GITHUB_TOKEN=ghp_1234567890abcdefghij',
      } as never),
    ).toThrow(CodingError);
  });

  it('exposes no permission, limit, tool, or command fields to mutate', () => {
    const plan = validPlan() as unknown as Record<string, unknown>;
    for (const forbidden of ['permissions', 'limits', 'tools', 'commands', 'credentials']) {
      expect(plan[forbidden]).toBeUndefined();
    }
  });
});

describe('bindCodingAction', () => {
  it('binds every supported action to its declared tool', () => {
    const projectId = 'proj_1';
    const workspaceId = 'ws_1';
    expect(bindCodingAction({ type: 'inspect_project' }, projectId, workspaceId).toolId).toBe(
      CODING_TOOL_IDS.inspectProject,
    );
    expect(
      bindCodingAction({ type: 'read_file', path: 'README.md' }, projectId, workspaceId).toolId,
    ).toBe(CODING_TOOL_IDS.readFile);
    expect(bindCodingAction({ type: 'list_files' }, projectId, workspaceId).toolId).toBe(
      CODING_TOOL_IDS.listFiles,
    );
    expect(
      bindCodingAction({ type: 'create_file', path: 'README.md' }, projectId, workspaceId).toolId,
    ).toBe(CODING_TOOL_IDS.createFile);
    expect(
      bindCodingAction({ type: 'update_file', path: 'a.ts', content: 'x' }, projectId, workspaceId)
        .toolId,
    ).toBe(CODING_TOOL_IDS.updateFile);
    expect(
      bindCodingAction({ type: 'delete_file', path: 'a.ts' }, projectId, workspaceId).toolId,
    ).toBe(CODING_TOOL_IDS.deleteFile);
    expect(
      bindCodingAction(
        { type: 'move_file', fromPath: 'a.ts', toDirectory: 'src' },
        projectId,
        workspaceId,
      ).toolId,
    ).toBe(CODING_TOOL_IDS.moveFile);
    expect(
      bindCodingAction(
        { type: 'validate', command: 'npm', arguments: ['test'] },
        projectId,
        workspaceId,
      ).toolId,
    ).toBe(CODING_TOOL_IDS.sandboxExecute);
  });

  it('rejects unknown action types - the model cannot invent tools', () => {
    expect(() => bindCodingAction({ type: 'run_arbitrary_shell' } as never, 'p', 'w')).toThrowError(
      /unknown action type/,
    );
    expect(() => bindCodingAction({ type: 'grant_permissions' } as never, 'p', 'w')).toThrowError(
      /unknown action type/,
    );
  });

  it('rejects action inputs with control characters', () => {
    expect(() => bindCodingAction({ type: 'read_file', path: 'a\x00.ts' }, 'p', 'w')).toThrow(
      CodingError,
    );
  });

  it('rejects secret-shaped file content', () => {
    expect(() =>
      bindCodingAction(
        { type: 'update_file', path: 'a.ts', content: 'KEY = "sk-proj-abcdefghij1234567890abcd"' },
        'p',
        'w',
      ),
    ).toThrowError(/secret-shaped/);
  });

  it('maps validate actions to structured command + arguments (never a shell string)', () => {
    const binding = bindCodingAction(
      { type: 'validate', command: 'npm', arguments: ['test', '--silent'] },
      'p',
      'w',
    );
    expect(binding.input.command).toBe('npm');
    expect(binding.input.arguments).toEqual(['test', '--silent']);
    expect(String(binding.input.command)).not.toMatch(/bash|-c/);
  });
});

describe('resolveCodingLimits', () => {
  it('uses safe defaults', () => {
    const limits = resolveCodingLimits();
    expect(limits).toEqual(CODING_LIMIT_DEFAULTS);
  });

  it('caps trusted server-side overrides at hard ceilings', () => {
    const limits = resolveCodingLimits({
      maxIterations: 100000,
      maxToolCalls: 100000,
      maxDurationMs: Number.MAX_SAFE_INTEGER,
      maxConsecutiveFailures: 100000,
    });
    expect(limits).toEqual(CODING_LIMIT_CEILINGS);
  });

  it('rejects non-positive or non-integer overrides', () => {
    expect(() => resolveCodingLimits({ maxIterations: 0 })).toThrow(CodingError);
    expect(() => resolveCodingLimits({ maxToolCalls: 1.5 })).toThrow(CodingError);
  });
});

describe('assertCodingToolsRegistered', () => {
  it('reports missing tools with a typed error', () => {
    const fakeTools = {
      inspect(toolId: string) {
        void toolId;
        throw new Error('not found');
      },
    };
    expect(() => assertCodingToolsRegistered(fakeTools as never)).toThrowError(
      /required tool "project.inspect" is not registered/,
    );
  });
});

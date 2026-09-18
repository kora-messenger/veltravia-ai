/**
 * The deterministic, fully offline DebugAgent for the Testing & Debugging
 * Agent. It executes NOTHING, reads NO host files, and calls NO AI provider:
 * it inspects the bounded, untrusted project content the TestingManager read
 * through the Tool System and proposes scripted, pattern-based diagnoses and
 * repairs for the documented mock scenarios.
 *
 * Recognized scenario (documented, honest):
 *   A package manifest whose "test" script contains the offline mock
 *   sandbox's failure marker argument ("fail") is diagnosed, and a repair
 *   that removes ONE marker occurrence per attempt is proposed. This covers
 *   the full diagnose -> approve -> repair -> retest loop against the real
 *   Project Engine + Coding Agent, with no faked results.
 *
 * Everything else is declined honestly: the mock never invents a root cause.
 */

import type {
  DebugAgent,
  DebugProposal,
  DebugRequest,
  Diagnosis,
  RepairPlan,
} from '@veltravia/testing-core';

/** The offline mock sandbox's documented failure-marker argument. */
export const MOCK_FAILURE_MARKER = 'fail';

/** Honest, bounded explanation for every declined analysis. */
export const MOCK_DEBUG_DECLINE_REASON =
  'the offline mock debugger found no recognized, reproducible pattern in the available project content';

interface ParsedManifest {
  readonly json: Record<string, unknown>;
  readonly testScript: string;
}

function parseManifest(request: DebugRequest): ParsedManifest | null {
  const manifestFile = request.untrustedFiles.find((file) => file.path === 'package.json');
  if (manifestFile === undefined) return null;
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifestFile.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    json = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const scripts =
    typeof json.scripts === 'object' && json.scripts !== null
      ? (json.scripts as Record<string, unknown>)
      : {};
  const testScript = typeof scripts.test === 'string' ? scripts.test : null;
  if (testScript === null) return null;
  return { json, testScript };
}

/** Removes ONE occurrence of the marker token (deterministic, per attempt). */
function removeOneMarkerToken(script: string): string | null {
  const tokens = script.trim().split(/\s+/);
  const index = tokens.lastIndexOf(MOCK_FAILURE_MARKER);
  if (index === -1) return null;
  tokens.splice(index, 1);
  return tokens.join(' ');
}

function buildDiagnosis(request: DebugRequest, testScript: string): Diagnosis {
  return {
    category: request.failure.failureCategory,
    summary:
      'The test command reports failure; the manifest test script contains the offline mock sandbox failure marker',
    statements: [
      {
        kind: 'fact',
        text: `The "test" script is declared as "${testScript}"`,
        evidence: 'package manifest content read through the project engine',
      },
      {
        kind: 'fact',
        text: `The failed command exited with code ${String(request.failure.failedCommand.exitCode)}`,
        evidence: 'bounded, scrubbed sandbox execution result',
      },
      {
        kind: 'inference',
        text: 'The offline mock sandbox reports a failure for commands whose arguments include the "fail" marker; removing the marker should let the command succeed',
        confidence: 'high',
        evidence: 'documented mock runtime behavior',
      },
      {
        kind: 'recommendation',
        text: 'Remove the failure-marker argument from the test script and retest',
      },
    ],
    affectedPaths: ['package.json'],
    confidence: 'high',
    recommendedAction: 'Approve the manifest repair and retest the test script',
  };
}

class MockDebugAgent implements DebugAgent {
  async analyze(request: DebugRequest): Promise<DebugProposal> {
    const parsed = parseManifest(request);
    if (parsed === null) {
      return {
        diagnosis: {
          category: request.failure.failureCategory,
          summary: 'The failure could not be traced to a recognized pattern',
          statements: [
            {
              kind: 'fact',
              text: 'The failed command reported a non-zero exit code',
              evidence: request.failure.failedCommand.stderrSummary || 'bounded sandbox output',
            },
            {
              kind: 'inference',
              text: 'The available project content did not contain a recognized, reproducible cause',
              confidence: 'low',
            },
          ],
          affectedPaths: [],
          confidence: 'low',
          recommendedAction: 'Inspect the failing command output manually',
        },
        repairPlan: null,
        declinedReason: MOCK_DEBUG_DECLINE_REASON,
      };
    }
    const repairedScript = removeOneMarkerToken(parsed.testScript);
    if (repairedScript === null) {
      return {
        diagnosis: buildDiagnosis(request, parsed.testScript),
        repairPlan: null,
        declinedReason: 'the manifest test script contains no failure-marker argument to remove',
      };
    }
    const json: Record<string, unknown> = {
      ...parsed.json,
      scripts: {
        ...(parsed.json.scripts as Record<string, unknown> | undefined),
        test: repairedScript,
      },
    };
    const content = `${JSON.stringify(json, null, 2)}\n`;
    const diagnosis = buildDiagnosis(request, parsed.testScript);
    const repairPlan: RepairPlan = {
      diagnosis,
      changes: [
        {
          path: 'package.json',
          mode: 'update',
          content,
          reason: 'Removes one failure-marker argument from the test script',
          expectedEffect: 'The test command runs without the mock failure marker',
        },
      ],
      risk: 'low',
      scope: 'single-file',
      verificationPlan: 'Rerun the test script and require a passing exit code',
      testsToRerun: ['npm script "test"'],
    };
    return { diagnosis, repairPlan };
  }
}

export function createMockDebugAgent(): DebugAgent {
  return new MockDebugAgent();
}

/** Scripted decline agent: never proposes a repair (limit/decline scenarios). */
export function createDecliningDebugAgent(): DebugAgent {
  return {
    async analyze(request): Promise<DebugProposal> {
      return {
        diagnosis: {
          category: request.failure.failureCategory,
          summary: 'No confident diagnosis was possible',
          statements: [
            {
              kind: 'fact',
              text: 'The failed command reported a non-zero exit code',
              evidence: request.failure.failedCommand.stderrSummary || 'bounded sandbox output',
            },
            {
              kind: 'inference',
              text: 'The evidence available to the offline debugger is insufficient for a root cause',
              confidence: 'low',
            },
          ],
          affectedPaths: [],
          confidence: 'low',
          recommendedAction: 'Inspect the failing command output manually',
        },
        repairPlan: null,
        declinedReason: MOCK_DEBUG_DECLINE_REASON,
      };
    },
  };
}

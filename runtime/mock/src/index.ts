/**
 * @veltravia/runtime-mock - the deterministic, simulated Mock Runtime
 * Executor (Step 17).
 *
 * DEVELOPMENT / CI ONLY. This executor is `isolationLevel: "simulated"` and
 * NEVER claims OS isolation. It builds NOTHING, starts NO process, opens NO
 * port, and touches NO host: behaviors are simulated logically from the
 * plan + an explicit scenario, so tests exercise the manager's validation,
 * lifecycle, revision binding, logs, limits, cancellation, and audit
 * without ever running project code on the host.
 *
 * The preview content it serves is an explicitly-labeled SIMULATED page
 * (it renders bounded plan metadata, never project file content). A
 * production runtime must implement the same `RuntimeExecutor` interface
 * behind a hardened boundary (container, microVM, or dedicated worker).
 */

import type {
  ExecutorBuildResult,
  ExecutorHealthReport,
  ExecutorLogLine,
  ExecutorRuntimeHandle,
  ExecutorStartResult,
  PreviewContentMeta,
  RuntimeExecutor,
  RuntimeResourceEnforcement,
} from '@veltravia/runtime-core';

/** Simulated scenarios (QA selects these; "ok" is the default). */
export const MOCK_RUNTIME_SCENARIOS = [
  'ok',
  'build-failure',
  'missing-dependency',
  'start-failure',
  'port-conflict',
  'health-failure',
  'resource-limit',
  'flaky-then-healthy',
] as const;

export type MockRuntimeScenario = (typeof MOCK_RUNTIME_SCENARIOS)[number];

/**
 * Honest enforcement report: NOTHING is OS-enforced by the mock. Lifetime
 * and log ceilings are logically enforced by the manager; build/start
 * timeouts are simulated only.
 */
export const MOCK_RUNTIME_ENFORCEMENT: RuntimeResourceEnforcement = Object.freeze({
  buildTimeoutMs: 'requested',
  startTimeoutMs: 'requested',
  maxLifetimeMs: 'enforced',
  idleTimeoutMs: 'enforced',
  maxMemoryMb: 'unavailable',
  maxDiskMb: 'unavailable',
  maxLogBytes: 'enforced',
});

/** Every request the mock received (isolation + behavior tests). */
export interface CapturedExecutorCall {
  readonly kind: 'build' | 'start' | 'health' | 'stop' | 'preview';
  readonly runtimeId: string;
  readonly scenario?: string;
}

function isKnownScenario(scenario: string | undefined): scenario is MockRuntimeScenario {
  return (MOCK_RUNTIME_SCENARIOS as readonly string[]).includes(scenario ?? '');
}

export class MockRuntimeExecutor implements RuntimeExecutor {
  readonly executorId = 'mock-runtime';
  readonly isolationLevel = 'simulated' as const;
  readonly enforcement = MOCK_RUNTIME_ENFORCEMENT;

  private readonly hosting = new Set<string>();
  private readonly healthProbeCounts = new Map<string, number>();
  private readonly flakyServed = new Map<string, number>();
  readonly capturedCalls: CapturedExecutorCall[] = [];

  private capture(kind: CapturedExecutorCall['kind'], handle: ExecutorRuntimeHandle): void {
    this.capturedCalls.push({
      kind,
      runtimeId: handle.runtimeId,
      ...(handle.scenario !== undefined ? { scenario: handle.scenario } : {}),
    });
  }

  private scenarioOf(handle: ExecutorRuntimeHandle): MockRuntimeScenario {
    const scenario = handle.scenario;
    if (scenario === undefined || scenario === '') {
      return 'ok';
    }
    if (!isKnownScenario(scenario)) {
      throw new Error(`MockRuntimeExecutor: unknown scenario "${scenario}"`);
    }
    return scenario;
  }

  async build(handle: ExecutorRuntimeHandle): Promise<ExecutorBuildResult> {
    this.capture('build', handle);
    const scenario = this.scenarioOf(handle);
    const { buildCommand } = handle.plan;
    if (buildCommand === null) {
      return {
        ok: true,
        failureKind: null,
        message: 'no build step in plan',
        logs: [],
        durationMs: 0,
      };
    }
    const label = buildCommand.label ?? buildCommand.executable;
    const logs: ExecutorLogLine[] = [
      {
        level: 'info',
        phase: 'build',
        message: `[simulated] running ${label} ${buildCommand.arguments.join(' ')}`,
      },
    ];
    switch (scenario) {
      case 'build-failure':
        logs.push({
          level: 'error',
          phase: 'build',
          message: '[simulated] build exited with status 1 - syntax error in src/App.tsx',
        });
        return {
          ok: false,
          failureKind: 'build_failed',
          message: 'build command failed (simulated)',
          logs,
          durationMs: 1200,
        };
      case 'missing-dependency':
        logs.push({
          level: 'error',
          phase: 'build',
          message: '[simulated] cannot resolve dependency - node_modules is absent',
        });
        return {
          ok: false,
          failureKind: 'missing_dependency',
          message: 'a required dependency is not installed (simulated)',
          logs,
          durationMs: 800,
        };
      case 'resource-limit':
        logs.push({
          level: 'error',
          phase: 'build',
          message: '[simulated] build exceeded its memory allowance',
        });
        return {
          ok: false,
          failureKind: 'resource_exhausted',
          message: 'build exhausted its resource allowance (simulated)',
          logs,
          durationMs: 900,
        };
      default:
        logs.push({
          level: 'info',
          phase: 'build',
          message: '[simulated] build completed with no errors',
        });
        return {
          ok: true,
          failureKind: null,
          message: 'build succeeded (simulated)',
          logs,
          durationMs: 1500,
        };
    }
  }

  async start(handle: ExecutorRuntimeHandle): Promise<ExecutorStartResult> {
    this.capture('start', handle);
    const scenario = this.scenarioOf(handle);
    const { startCommand } = handle.plan;
    const label = startCommand.label ?? startCommand.executable;
    const logs: ExecutorLogLine[] = [
      {
        level: 'info',
        phase: 'start',
        message: `[simulated] launching ${label} ${startCommand.arguments.join(' ')}`,
      },
    ];
    switch (scenario) {
      case 'start-failure':
        logs.push({
          level: 'error',
          phase: 'start',
          message: '[simulated] server exited immediately with status 1',
        });
        return {
          ok: false,
          failureKind: 'start_failed',
          message: 'start command failed (simulated)',
          logs,
          previewToken: null,
        };
      case 'port-conflict':
        logs.push({
          level: 'error',
          phase: 'start',
          message: '[simulated] the preview port is already in use',
        });
        return {
          ok: false,
          failureKind: 'port_conflict',
          message: 'the declared preview port is unavailable (simulated)',
          logs,
          previewToken: null,
        };
      default:
        this.hosting.add(handle.runtimeId);
        this.healthProbeCounts.set(handle.runtimeId, 0);
        this.flakyServed.set(handle.runtimeId, 0);
        logs.push({
          level: 'info',
          phase: 'start',
          message: '[simulated] preview server listening on the declared port',
        });
        return {
          ok: true,
          failureKind: null,
          message: 'preview started (simulated)',
          logs,
          previewToken: `tok_${handle.runtimeId}`,
        };
    }
  }

  async health(handle: ExecutorRuntimeHandle): Promise<ExecutorHealthReport> {
    this.capture('health', handle);
    const scenario = this.scenarioOf(handle);
    if (!this.hosting.has(handle.runtimeId)) {
      return { status: 'stopped', message: 'the simulated preview is not hosted' };
    }
    const count = (this.healthProbeCounts.get(handle.runtimeId) ?? 0) + 1;
    this.healthProbeCounts.set(handle.runtimeId, count);
    if (scenario === 'health-failure') {
      return {
        status: 'unhealthy',
        message: 'health check failed (simulated): the preview did not respond',
      };
    }
    if (scenario === 'flaky-then-healthy') {
      const served = (this.flakyServed.get(handle.runtimeId) ?? 0) + 1;
      this.flakyServed.set(handle.runtimeId, served);
      if (served < 3) {
        return { status: 'starting', message: 'still warming up (simulated)' };
      }
    }
    return { status: 'healthy', message: 'health check passed (simulated)' };
  }

  previewContent(handle: ExecutorRuntimeHandle, meta: PreviewContentMeta): string {
    this.capture('preview', handle);
    const { plan } = handle;
    const banner =
      meta.isolationLevel === 'simulated'
        ? 'SIMULATED PREVIEW — no real build or server ran (mock runtime executor)'
        : 'PREVIEW';
    const startLabel = plan.startCommand.label ?? plan.startCommand.executable;
    const buildLabel = plan.buildCommand
      ? (plan.buildCommand.label ?? plan.buildCommand.executable)
      : null;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veltravia preview</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f1222; color: #e6e9f4; }
  .card { max-width: 640px; padding: 32px; border: 1px solid #2a2f4a; border-radius: 12px; background: #171b30; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #f59e0b; color: #1c1200; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; }
  h1 { font-size: 18px; margin: 12px 0 6px; }
  p { margin: 6px 0; font-size: 14px; line-height: 1.5; color: #b9bfd8; }
  code { background: #10132a; border: 1px solid #2a2f4a; border-radius: 6px; padding: 1px 6px; font-size: 13px; }
  ul { margin: 10px 0 0; padding-left: 18px; font-size: 14px; color: #b9bfd8; }
  li { margin: 3px 0; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">SIMULATED RUNTIME</span>
    <h1>${escapeHtml(meta.projectName)} — preview</h1>
    <p><strong>${escapeHtml(banner)}</strong></p>
    <ul>
      <li>Runtime type: <code>${escapeHtml(plan.runtimeType)}</code></li>
      <li>Workspace revision: <code>${escapeHtml(String(handle.revision))}</code></li>
      ${buildLabel === null ? '' : `<li>Build: <code>${escapeHtml(buildLabel)}</code></li>`}
      <li>Start: <code>${escapeHtml(startLabel)}</code></li>
      <li>Executor: <code>${escapeHtml(meta.executorId)}</code> (isolation: <code>${escapeHtml(meta.isolationLevel)}</code>)</li>
    </ul>
    <p>The preview gateway routes you here through the platform-controlled URL. A production runtime will render the real application; this mock shows the plan honestly.</p>
  </main>
</body>
</html>`;
  }

  async stop(handle: ExecutorRuntimeHandle): Promise<void> {
    this.capture('stop', handle);
    this.hosting.delete(handle.runtimeId);
    this.healthProbeCounts.delete(handle.runtimeId);
    this.flakyServed.delete(handle.runtimeId);
  }

  isHosting(handle: ExecutorRuntimeHandle): boolean {
    return this.hosting.has(handle.runtimeId);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createMockRuntimeExecutor(): MockRuntimeExecutor {
  return new MockRuntimeExecutor();
}

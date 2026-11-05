import { randomUUID } from 'node:crypto';
import {
  generateTests,
  inspectApplication,
  runSecurityChecks,
  translateRun,
  type AppInspection,
  type AppTestReport,
  type ExecutionEnvironment,
  type GeneratedTestCase,
  type SecurityFinding,
  type TestGenerationResult,
  type TestRunView,
  type TestingManager,
} from '@veltravia/testing-core';

import { TestingAccessError, TestingRunLedger } from './testing-ownership.js';

/**
 * The application-testing service (Step 39).
 *
 * It sits on top of the Step 14 TestingManager and adds what that manager does
 * not do: inspect the application, generate tests, check security, and turn a
 * run into a report. It never runs a command and never changes a file. Every
 * read goes through the Tool System, and every run, approval and repair still
 * belongs to the TestingManager and the Coding Agent behind it.
 *
 * What it keeps per run (and why): the inspection, the findings and the file
 * list, taken when the run starts, so a report describes the code that was
 * tested even if the project changes afterwards.
 */

export interface AppTestContext {
  readonly inspection: AppInspection;
  readonly findings: readonly SecurityFinding[];
  readonly generated: TestGenerationResult;
  readonly knownFiles: readonly string[];
  readonly readNotes: readonly string[];
}

export interface AppTestingServiceOptions {
  readonly testing: TestingManager;
  readonly ledger: TestingRunLedger;
  /** What the sandbox runtime really is. Supplied by whoever built it. */
  readonly environment: ExecutionEnvironment;
  readonly now?: () => Date;
}

export interface StartInput {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

/** A run's start, with what was found and what is proposed. */
export interface StartedRun {
  readonly run: TestRunView;
  readonly inspection: AppInspection;
  readonly generatedTests: readonly GeneratedTestSummary[];
  readonly skippedKinds: TestGenerationResult['skipped'];
  readonly notes: readonly string[];
}

/** A proposed test, without its source. Source is only written after approval. */
export interface GeneratedTestSummary {
  readonly id: string;
  readonly kind: GeneratedTestCase['kind'];
  readonly title: string;
  readonly target: string;
  readonly path: string;
  readonly runner: GeneratedTestCase['runner'];
}

function summarise(test: GeneratedTestCase): GeneratedTestSummary {
  return {
    id: test.id,
    kind: test.kind,
    title: test.title,
    target: test.target,
    path: test.path,
    runner: test.runner,
  };
}

export class AppTestingService {
  private readonly contexts = new Map<string, AppTestContext>();
  private readonly now: () => Date;

  constructor(private readonly options: AppTestingServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Inspects, plans and starts a run. Throws TestingAccessError for a foreign project. */
  async start(input: StartInput): Promise<StartedRun> {
    await this.options.ledger.assertCanStart(input.ownerRef, input.projectId, input.workspaceId);

    // Record the scope BEFORE the run starts: the run lists its workspace while it
    // starts, and the project tools only act inside a recorded run's own workspace.
    const runId = `testrun_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.options.ledger.record(runId, {
      ownerRef: input.ownerRef,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
    });
    const run = await this.options.testing.startRun({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      runId,
    });
    // The read is held to this run's workspace.
    const read = await this.options.testing.readWorkspaceFiles(input.workspaceId, run.runId);
    const inspection = inspectApplication(read.files);
    const findings = runSecurityChecks(read.files, inspection);
    const generated = generateTests(inspection);

    const context: AppTestContext = {
      inspection,
      findings,
      generated,
      knownFiles: read.files.map((file) => file.path),
      readNotes: read.notes,
    };
    this.contexts.set(run.runId, context);

    return {
      run,
      inspection,
      generatedTests: generated.cases.map(summarise),
      skippedKinds: generated.skipped,
      notes: [...read.notes, ...inspection.notes, ...generated.notes],
    };
  }

  /** The run as the Step 14 manager sees it. Owner-checked. */
  status(ownerRef: string, runId: string): TestRunView {
    this.options.ledger.require(ownerRef, runId);
    return this.options.testing.getRun(runId);
  }

  /** The structured report. Owner-checked. */
  report(ownerRef: string, runId: string): AppTestReport {
    this.options.ledger.require(ownerRef, runId);
    const run = this.options.testing.getRun(runId);
    const context = this.requireContext(runId);
    return translateRun({
      run,
      inspection: context.inspection,
      findings: context.findings,
      environment: this.options.environment,
      knownFiles: context.knownFiles,
      generatedAt: this.now().toISOString(),
    });
  }

  /** What was found in the application, and what is proposed. Owner-checked. */
  inspection(ownerRef: string, runId: string): StartedRun['inspection'] {
    this.options.ledger.require(ownerRef, runId);
    return this.requireContext(runId).inspection;
  }

  /** The proposed tests, without source. Owner-checked. */
  proposedTests(ownerRef: string, runId: string): readonly GeneratedTestSummary[] {
    this.options.ledger.require(ownerRef, runId);
    return this.requireContext(runId).generated.cases.map(summarise);
  }

  private requireContext(runId: string): AppTestContext {
    const context = this.contexts.get(runId);
    if (context === undefined) throw new TestingAccessError();
    return context;
  }
}

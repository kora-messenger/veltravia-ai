/** Owner-scoped synthesis jobs.
 *
 * Same shape as the earlier steps' job management: bounded per owner, one-way
 * cancellation, retention, and no cross-owner visibility. Jobs run in-process;
 * a durable queue is a deployment concern, not claimed here.
 */
import { IntelligenceError } from '../errors/index.js';
import {
  DEFAULT_INTELLIGENCE_LIMITS,
  type IntelligenceLimits,
  type SynthesisAnswer,
  type SynthesisJob,
} from '../types/index.js';

export interface SynthesisRunner {
  run(
    ownerRef: string,
    question: string,
    options: Record<string, unknown>,
  ): Promise<SynthesisAnswer>;
}

export interface SynthesisJobManagerOptions {
  readonly runner: (input: {
    readonly ownerRef: string;
    readonly question: string;
    readonly filters: Record<string, unknown>;
  }) => Promise<SynthesisAnswer>;
  readonly limits?: Partial<IntelligenceLimits>;
  readonly now?: () => Date;
  readonly newId?: (() => string) | undefined;
}

interface JobRecord {
  readonly ownerRef: string;
  job: SynthesisJob;
  cancelled: boolean;
}

export class SynthesisJobManager {
  readonly #records = new Map<string, JobRecord>();
  readonly #limits: IntelligenceLimits;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #runner: SynthesisJobManagerOptions['runner'];
  #sequence = 0;

  constructor(options: SynthesisJobManagerOptions) {
    this.#limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...(options.limits ?? {}) };
    this.#now = options.now ?? (() => new Date());
    const provided = options.newId;
    this.#newId = provided ?? (() => `syn_${(this.#sequence += 1).toString(36)}`);
    this.#runner = options.runner;
  }

  #expire(): void {
    const now = this.#now().getTime();
    for (const [jobId, record] of this.#records) {
      const updated = new Date(record.job.updatedAt).getTime();
      if (now - updated > this.#limits.jobRetentionSeconds * 1000) this.#records.delete(jobId);
    }
  }

  #require(ownerRef: string, jobId: string): JobRecord {
    this.#expire();
    const record = this.#records.get(jobId);
    // A foreign job is indistinguishable from a missing one.
    if (!record || record.ownerRef !== ownerRef)
      throw new IntelligenceError('INTELLIGENCE_JOB_NOT_FOUND', 'That analysis job was not found.');
    return record;
  }

  async create(
    ownerRef: string,
    question: string,
    filters: Record<string, unknown> = {},
  ): Promise<SynthesisJob> {
    this.#expire();
    const owned = [...this.#records.values()].filter((record) => record.ownerRef === ownerRef);
    if (owned.length >= this.#limits.maxJobsPerOwner) {
      const oldest = owned.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt))[0];
      if (oldest) this.#records.delete(oldest.job.jobId);
    }
    const now = this.#now().toISOString();
    const jobId = this.#newId();
    const record: JobRecord = {
      ownerRef,
      cancelled: false,
      job: {
        jobId,
        question,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        result: null,
        error: null,
      },
    };
    this.#records.set(jobId, record);

    // Run asynchronously; the caller polls. No timers are left behind: the run
    // settles the record itself.
    void (async () => {
      record.job = { ...record.job, status: 'running', updatedAt: this.#now().toISOString() };
      try {
        const result = await this.#runner({ ownerRef, question, filters });
        if (record.cancelled) {
          record.job = {
            ...record.job,
            status: 'cancelled',
            updatedAt: this.#now().toISOString(),
          };
          return;
        }
        record.job = {
          ...record.job,
          status: 'completed',
          result,
          updatedAt: this.#now().toISOString(),
          completedAt: this.#now().toISOString(),
        };
      } catch (error) {
        if (record.cancelled) {
          record.job = {
            ...record.job,
            status: 'cancelled',
            updatedAt: this.#now().toISOString(),
          };
          return;
        }
        record.job = {
          ...record.job,
          status: 'failed',
          updatedAt: this.#now().toISOString(),
          completedAt: this.#now().toISOString(),
          error: {
            code:
              typeof error === 'object' && error !== null && 'code' in error
                ? String((error as { code: unknown }).code)
                : 'INTELLIGENCE_PROVIDER_ERROR',
            message:
              error instanceof Error && error.message.length > 0
                ? error.message
                : 'The analysis failed.',
          },
        };
      }
    })();

    return record.job;
  }

  get(ownerRef: string, jobId: string): SynthesisJob {
    return this.#require(ownerRef, jobId).job;
  }

  list(ownerRef: string): readonly SynthesisJob[] {
    this.#expire();
    return [...this.#records.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .map((record) => record.job)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cancel(ownerRef: string, jobId: string): SynthesisJob {
    const record = this.#require(ownerRef, jobId);
    if (record.job.status === 'completed' || record.job.status === 'failed')
      throw new IntelligenceError(
        'INTELLIGENCE_JOB_STATE',
        'That analysis has already finished and cannot be cancelled.',
      );
    record.cancelled = true;
    record.job = { ...record.job, status: 'cancelled', updatedAt: this.#now().toISOString() };
    return record.job;
  }
}

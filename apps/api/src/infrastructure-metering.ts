/**
 * Infrastructure metering (Step 57, completing Step 52).
 *
 * Step 52 built the meter: categories, quotas, an append-only record per
 * operation key, and a capability table that states how each number was
 * obtained. What it did not have was a source for three of those categories.
 * This file is that source, and it is written to one rule: **only numbers this
 * process actually observed are recorded.**
 *
 * | Category   | How it is obtained                                            |
 * | ---------- | ------------------------------------------------------------- |
 * | file storage | the byte length of the buffer the upload handler accepted, and the same length released on delete |
 * | bandwidth  | request and response bytes measured on the way through this API, accumulated per owner and flushed as one record per interval |
 * | realtime   | the stream this API opens and closes itself: the connection, its duration and the events it emitted |
 *
 * What is deliberately **not** here:
 *
 *  - **Hosting runtime** - applications are not hosted by a deployment
 *    integration in this build, so there is nothing to observe.
 *  - **Physical database size** - indexes, WAL and per-table overhead are not
 *    attributable per owner; Step 52 keeps that number a derived floor.
 *  - **Provider egress and CDN bytes** - they never reach this process. The note
 *    on the bandwidth capability says so, and the quota is best-effort.
 *
 * Every write is a `recordUsage` call on the Step 52 meter, so an infrastructure
 * number lands in the same append-only ledger, is billed once by its operation
 * key, and appears in the same dashboard as everything else.
 */

import type { UsageRecord } from '@veltravia/usage-core';

import type { UsageService } from './usage-service.js';

/** The interval a bandwidth sample covers. One minute keeps a record readable. */
const BANDWIDTH_BUCKET_MS = 60_000;

const MINUTE = 60_000;

export interface StorageEventInput {
  readonly ownerRef: string;
  readonly projectId?: string | null;
  readonly fileId: string;
  readonly bytes: number;
  /** `added` is an upload or import; `removed` a delete or expiry. */
  readonly direction: 'added' | 'removed';
  readonly reason?: string | null;
}

export interface StreamHandle {
  readonly id: string;
  readonly ownerRef: string;
  /** Counts one event the server wrote to the stream. */
  event(): void;
  /** Closes the stream once, recording the connection and its events. */
  close(reason?: string): Promise<void>;
}

export interface InfrastructureMetering {
  /** Records uploaded bytes. Returns null when the number cannot be observed. */
  recordStorage(input: StorageEventInput): Promise<UsageRecord | null>;
  /** Accumulates one request's bytes in memory; nothing is written per request. */
  observeTransfer(input: {
    readonly ownerRef: string;
    readonly requestBytes?: number | null;
    readonly responseBytes?: number | null;
  }): void;
  /** Writes the accumulated bandwidth for every owner that has some. */
  flushBandwidth(): Promise<{ readonly owners: number; readonly bytes: number }>;
  /** Opens a tracked stream. The caller must `close()` it. */
  openStream(input: { readonly ownerRef: string; readonly kind?: string }): StreamHandle;
  /** Live connections for one owner, for the published limit. */
  liveStreams(ownerRef: string): number;
  /** What has been observed since the process started. Diagnostic only. */
  stats(): {
    readonly liveStreams: number;
    readonly bufferedOwners: number;
    readonly bufferedBytes: number;
    readonly flushedBytes: number;
  };
  /** Starts the periodic bandwidth flush. `0` seconds disables it. */
  start(intervalSeconds: number): { stop(): void };
}

export interface InfrastructureMeteringOptions {
  readonly usage: UsageService;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

interface BandwidthBucket {
  requestBytes: number;
  responseBytes: number;
  /** The bucket a sample belongs to, as an ISO minute. */
  bucket: string;
}

const finiteNonNegative = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
};

export function createInfrastructureMetering(
  options: InfrastructureMeteringOptions,
): InfrastructureMetering {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);

  const buckets = new Map<string, BandwidthBucket>();
  const streams = new Map<string, { ownerRef: string; openedAt: number; events: number; closed: boolean }>();
  let seq = 0;
  let flushedBytes = 0;

  const bucketOf = (at: Date): string =>
    new Date(Math.floor(at.getTime() / BANDWIDTH_BUCKET_MS) * BANDWIDTH_BUCKET_MS).toISOString();

  const metering: InfrastructureMetering = {
    async recordStorage(input) {
      const bytes = finiteNonNegative(input.bytes);
      // A file whose size nobody measured contributes no record at all. Writing
      // zero would read as "measured, and it was empty".
      if (bytes === null || bytes === 0) return null;
      if (input.ownerRef.trim() === '' || input.fileId.trim() === '') return null;

      return options.usage.recordUsage({
        ownerRef: input.ownerRef,
        ...(input.projectId === undefined || input.projectId === null
          ? {}
          : { projectId: input.projectId }),
        category: 'file_storage',
        operation: input.direction === 'added' ? 'file.upload' : 'file.delete',
        resource: input.fileId,
        quantity: bytes,
        // The same file uploaded and deleted twice is two events; the same event
        // reported twice is one record.
        operationKey: `file:${input.fileId}:${input.direction}`,
        source: 'measured',
        detail: {
          direction: input.direction,
          ...(input.reason === undefined || input.reason === null ? {} : { reason: input.reason }),
          // A deletion releases bytes: the dashboard nets these out.
          signed: input.direction === 'added' ? bytes : -bytes,
        },
      });
    },

    observeTransfer(input) {
      const request = finiteNonNegative(input.requestBytes ?? 0) ?? 0;
      const response = finiteNonNegative(input.responseBytes ?? 0) ?? 0;
      if (request === 0 && response === 0) return;
      if (input.ownerRef.trim() === '') return;
      const bucket = bucketOf(now());
      const existing = buckets.get(input.ownerRef);
      if (existing === undefined || existing.bucket !== bucket) {
        // A stale bucket is flushed rather than merged: two minutes of traffic
        // must not become one sample pretending to be one minute.
        if (existing !== undefined) {
          buckets.set(`${input.ownerRef}\u0000stale`, existing);
        }
        buckets.set(input.ownerRef, { requestBytes: request, responseBytes: response, bucket });
        return;
      }
      existing.requestBytes += request;
      existing.responseBytes += response;
    },

    async flushBandwidth() {
      if (buckets.size === 0) return { owners: 0, bytes: 0 };
      const pending = [...buckets.entries()];
      buckets.clear();
      let owners = 0;
      let bytes = 0;
      for (const [key, bucket] of pending) {
        const ownerRef = key.split('\u0000')[0] as string;
        const total = bucket.requestBytes + bucket.responseBytes;
        if (total === 0) continue;
        try {
          await options.usage.recordUsage({
            ownerRef,
            category: 'bandwidth',
            operation: 'http.transfer',
            resource: bucket.bucket,
            quantity: total,
            // One sample per owner per minute, whichever process wrote it first.
            operationKey: `bandwidth:${ownerRef}:${bucket.bucket}`,
            source: 'measured',
            detail: {
              requestBytes: bucket.requestBytes,
              responseBytes: bucket.responseBytes,
              scope: 'api-process',
            },
          });
          owners += 1;
          bytes += total;
          flushedBytes += total;
        } catch (error) {
          log(
            `[veltravia-api] bandwidth sample for ${ownerRef} was not recorded: ${String(
              (error as Error)?.message ?? error,
            )}`,
          );
          // Put the sample back so the next tick retries it, unless a newer
          // bucket has already replaced it.
          if (!buckets.has(ownerRef)) buckets.set(ownerRef, bucket);
        }
      }
      return { owners, bytes };
    },

    openStream(input) {
      const id = `str_${now().getTime().toString(36)}_${++seq}`;
      streams.set(id, {
        ownerRef: input.ownerRef,
        openedAt: now().getTime(),
        events: 0,
        closed: false,
      });
      return {
        id,
        ownerRef: input.ownerRef,
        event: () => {
          const entry = streams.get(id);
          if (entry !== undefined) entry.events += 1;
        },
        close: async (reason?: string) => {
          const entry = streams.get(id);
          if (entry === undefined || entry.closed) return;
          entry.closed = true;
          streams.delete(id);
          const durationMs = Math.max(0, now().getTime() - entry.openedAt);
          try {
            await options.usage.recordUsage({
              ownerRef: entry.ownerRef,
              category: 'realtime',
              operation: 'stream.connection',
              resource: input.kind ?? 'chat.stream',
              quantity: 1,
              operationKey: `stream:${id}`,
              source: 'measured',
              detail: {
                durationMs,
                events: entry.events,
                ...(reason === undefined ? {} : { reason }),
              },
            });
          } catch {
            // A stream that has closed is closed; a metering write must not turn
            // a finished response into an error.
          }
        },
      };
    },

    liveStreams(ownerRef) {
      let count = 0;
      for (const entry of streams.values()) {
        if (!entry.closed && entry.ownerRef === ownerRef) count += 1;
      }
      return count;
    },

    stats: () => ({
      liveStreams: streams.size,
      bufferedOwners: buckets.size,
      bufferedBytes: [...buckets.values()].reduce(
        (sum, bucket) => sum + bucket.requestBytes + bucket.responseBytes,
        0,
      ),
      flushedBytes,
    }),

    start(intervalSeconds) {
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        log('[veltravia-api] bandwidth sampling is disabled (interval 0).');
        return { stop: () => undefined };
      }
      const interval = Math.max(intervalSeconds, 15) * 1000;
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        void metering
          .flushBandwidth()
          .catch(() => undefined)
          .finally(() => {
            running = false;
          });
      }, interval);
      timer.unref?.();
      return {
        stop: () => {
          clearInterval(timer);
        },
      };
    },
  };

  // One minute of drift is fine for a best-effort quota; the constant is exposed
  // so a test can align its clock instead of sleeping.
  void MINUTE;

  return metering;
}

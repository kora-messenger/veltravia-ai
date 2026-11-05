/**
 * The execution environment a report describes.
 *
 * A report must say what really ran its commands. This derives that from the
 * runtime's own declared facts and errs on the side of claiming less:
 *
 *  - `executedRealCode` is true ONLY for a runtime that is not a known
 *    simulator AND declares real OS-level isolation. An unknown runtime, or one
 *    that declares no isolation, is treated as not having run real code, so a
 *    new runtime has to opt in rather than be trusted by default.
 *  - `osIsolation` is copied from the runtime. It is never inferred upward.
 */

import type { ExecutionEnvironment } from './types.js';

/** Runtime ids known to simulate execution and run no host code. */
const SIMULATED_RUNTIMES: ReadonlySet<string> = new Set(['mock', 'sandbox-mock', 'simulated']);

export interface RuntimeFacts {
  readonly runtimeId: string;
  readonly providesOsIsolation: boolean;
}

export function describeEnvironment(
  runtime: RuntimeFacts,
  networkPolicy: ExecutionEnvironment['networkPolicy'] = 'unknown',
): ExecutionEnvironment {
  const id = runtime.runtimeId.trim().toLowerCase();
  const simulated = id === '' || SIMULATED_RUNTIMES.has(id) || id.includes('mock');
  return {
    runtimeId: runtime.runtimeId.trim() === '' ? 'unknown' : runtime.runtimeId,
    osIsolation: runtime.providesOsIsolation === true,
    executedRealCode: !simulated && runtime.providesOsIsolation === true,
    networkPolicy,
  };
}

import type { FastifyInstance } from 'fastify';

/**
 * Graceful shutdown.
 *
 * A deploy sends SIGTERM and then waits. Closing the server stops accepting new
 * connections and lets in-flight requests finish; only after that does the
 * process exit. A hard deadline means a stuck request cannot block a deploy
 * forever, and a second signal exits immediately for an operator who knows.
 */

export interface GracefulShutdownOptions {
  readonly signal?: 'SIGTERM' | 'SIGINT';
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => void;
}

export function installGracefulShutdown(
  app: FastifyInstance,
  options: GracefulShutdownOptions = {},
): () => Promise<void> {
  const log = options.log ?? (() => undefined);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.timeoutMs ?? 10_000;
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('shutdown: draining connections');
    const deadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), graceMs).unref(),
    );
    const outcome = await Promise.race([app.close().then(() => 'closed' as const), deadline]);
    if (outcome === 'timeout') {
      log('shutdown: grace period elapsed, exiting anyway');
      exit(1);
      return;
    }
    log('shutdown: closed cleanly');
    exit(0);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    log(`shutdown: ${signal}`);
    if (stopping) {
      log('shutdown: second signal, exiting now');
      exit(1);
      return;
    }
    void stop();
  };

  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return stop;
}

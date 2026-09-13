/**
 * Run cancellation. A cancellation request is a one-way flag: once set, the
 * agent loop stops at the next checkpoint, no further tool requests are
 * dispatched, the run is marked cancelled, an audit event is produced, and
 * the run never resumes automatically. Cancellation cannot be bypassed.
 */
export class CancellationController {
  private requested = false;

  /** Requests cancellation. Idempotent. */
  request(): void {
    this.requested = true;
  }

  /** Whether cancellation has been requested. The loop checks this at every checkpoint. */
  isRequested(): boolean {
    return this.requested;
  }
}

/** The cancellation checkpoint view handed to the agent. */
export interface AgentCancellation {
  isRequested(): boolean;
}

export function asAgentCancellation(controller: CancellationController): AgentCancellation {
  return { isRequested: () => controller.isRequested() };
}

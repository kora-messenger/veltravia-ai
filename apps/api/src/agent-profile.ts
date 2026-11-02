/**
 * Agent identity.
 *
 * Every owner names their own assistant, the way the platform this app was
 * modelled on lets a user rename their agent, and may give their own name so
 * the assistant can address them. Both values are display-only: neither is
 * ever sent to a model, neither is used for authorisation, and neither becomes
 * part of a run's context. Renaming grants nothing.
 *
 * Storage is per-owner and in-memory for this server process. That is honest
 * development storage, not durable storage: a restart restores the defaults,
 * and nothing here claims to survive one. A real deployment keeps the same
 * interface in front of a database.
 */

export const DEFAULT_AGENT_NAME = 'My Engineer';
export const MAX_NAME_LENGTH = 40;

export interface AgentProfile {
  readonly agentName: string;
  /** The owner's own name, or null when they have not given one. */
  readonly ownerName: string | null;
  /** True while the owner has never renamed the agent. */
  readonly isDefault: boolean;
  /** ISO timestamp of the last change, or null for the untouched default. */
  readonly updatedAt: string | null;
}

export type AgentProfileErrorCode =
  | 'AGENT_NAME_INVALID'
  | 'AGENT_NAME_TOO_LONG'
  | 'OWNER_NAME_INVALID'
  | 'OWNER_NAME_TOO_LONG'
  | 'PROFILE_EMPTY_UPDATE';

const MESSAGES: Record<AgentProfileErrorCode, string> = {
  AGENT_NAME_INVALID:
    'An agent name needs at least one visible character, without line breaks or control characters.',
  AGENT_NAME_TOO_LONG: `An agent name can be at most ${MAX_NAME_LENGTH} characters.`,
  OWNER_NAME_INVALID:
    'Your name needs at least one visible character, without line breaks or control characters.',
  OWNER_NAME_TOO_LONG: `Your name can be at most ${MAX_NAME_LENGTH} characters.`,
  PROFILE_EMPTY_UPDATE: 'Send an agent name, your own name, or both.',
};

export class AgentProfileError extends Error {
  readonly code: AgentProfileErrorCode;

  constructor(code: AgentProfileErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AgentProfileError';
    this.code = code;
  }
}

export function isAgentProfileError(error: unknown): error is AgentProfileError {
  return error instanceof AgentProfileError;
}

export function agentProfileHttpStatus(code: AgentProfileErrorCode): number {
  if (code === 'PROFILE_EMPTY_UPDATE') return 400;
  return code.endsWith('_TOO_LONG') ? 422 : 400;
}

/**
 * Names are trimmed and runs of whitespace become one space, so pasted text
 * with a stray double space does not render as a gap in the header. Anything
 * with a line break or control character is refused rather than silently
 * rewritten: a hidden newline would be a lie about the value that was stored.
 * Length is counted in characters, so a 40-emoji name fits.
 */
export function normaliseName(raw: string, field: 'agent' | 'owner'): string {
  const collapsed = raw.replace(/[ \t]+/g, ' ').trim();
  const invalid = field === 'agent' ? 'AGENT_NAME_INVALID' : 'OWNER_NAME_INVALID';
  const tooLong = field === 'agent' ? 'AGENT_NAME_TOO_LONG' : 'OWNER_NAME_TOO_LONG';
  if (collapsed === '') throw new AgentProfileError(invalid);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(collapsed)) throw new AgentProfileError(invalid);
  if ([...collapsed].length > MAX_NAME_LENGTH) throw new AgentProfileError(tooLong);
  return collapsed;
}

export interface AgentProfileUpdate {
  readonly agentName?: string;
  readonly ownerName?: string;
}

interface StoredProfile {
  agentName?: string;
  ownerName?: string;
  updatedAt: string;
}

export interface AgentProfileStoreOptions {
  readonly now?: () => Date;
  /** Owners kept in memory before the oldest entry is dropped. */
  readonly capacity?: number;
}

export class AgentProfileStore {
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly now: () => Date;
  private readonly capacity: number;

  constructor(options: AgentProfileStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.capacity = options.capacity ?? 5_000;
  }

  get(ownerRef: string): AgentProfile {
    return this.toProfile(this.profiles.get(ownerRef));
  }

  /** Applies only the fields that were sent; an absent field keeps its value. */
  update(ownerRef: string, update: AgentProfileUpdate): AgentProfile {
    const agentName =
      update.agentName === undefined ? undefined : normaliseName(update.agentName, 'agent');
    const ownerName =
      update.ownerName === undefined ? undefined : normaliseName(update.ownerName, 'owner');
    if (agentName === undefined && ownerName === undefined) {
      throw new AgentProfileError('PROFILE_EMPTY_UPDATE');
    }

    const current = this.profiles.get(ownerRef);
    const next: StoredProfile = {
      ...(agentName !== undefined ? { agentName } : {}),
      ...(ownerName !== undefined ? { ownerName } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (agentName === undefined && current?.agentName !== undefined) {
      next.agentName = current.agentName;
    }
    if (ownerName === undefined && current?.ownerName !== undefined) {
      next.ownerName = current.ownerName;
    }

    // Re-inserting moves the entry to the end: Map iteration order is the
    // eviction order, and the oldest untouched owner is the one dropped.
    this.profiles.delete(ownerRef);
    this.profiles.set(ownerRef, next);
    while (this.profiles.size > this.capacity) {
      const oldest = this.profiles.keys().next();
      if (oldest.done === true) break;
      this.profiles.delete(oldest.value);
    }
    return this.get(ownerRef);
  }

  /** Clears the custom agent name, restoring the default. */
  resetAgentName(ownerRef: string): AgentProfile {
    const current = this.profiles.get(ownerRef);
    if (current === undefined) return this.get(ownerRef);
    const remaining: StoredProfile = {
      ...(current.ownerName !== undefined ? { ownerName: current.ownerName } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (remaining.ownerName === undefined) {
      this.profiles.delete(ownerRef);
    } else {
      this.profiles.set(ownerRef, remaining);
    }
    return this.get(ownerRef);
  }

  get size(): number {
    return this.profiles.size;
  }

  private toProfile(stored: StoredProfile | undefined): AgentProfile {
    return {
      agentName: stored?.agentName ?? DEFAULT_AGENT_NAME,
      ownerName: stored?.ownerName ?? null,
      isDefault: stored?.agentName === undefined,
      updatedAt: stored?.updatedAt ?? null,
    };
  }
}

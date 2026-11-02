import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  getAgentProfile,
  resetAgentName,
  updateAgentProfile,
  type AgentProfile,
  type AgentProfileOptions,
} from '../api/agent-profile';

/**
 * One source of truth for what the assistant is called.
 *
 * The header, the conversation title and the greeting all read this, so a
 * rename shows everywhere at once instead of the page disagreeing with itself.
 * Until authentication exists the name is per browser (see `owner-ref.ts`), and
 * it is never presented as durable storage.
 */

export const DEFAULT_AGENT_NAME = 'My Engineer';
export const MAX_NAME_LENGTH = 40;

export interface SaveOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

export interface AgentProfileState {
  readonly agentName: string;
  readonly ownerName: string | null;
  readonly isDefault: boolean;
  readonly loading: boolean;
  /** Set when the profile could not be read or written, in plain words. */
  readonly error: string | null;
  readonly saving: boolean;
  save(patch: { readonly agentName?: string; readonly ownerName?: string }): Promise<SaveOutcome>;
  resetName(): Promise<SaveOutcome>;
}

const FALLBACK: AgentProfileState = {
  agentName: DEFAULT_AGENT_NAME,
  ownerName: null,
  isDefault: true,
  loading: false,
  error: null,
  saving: false,
  save: async () => ({ ok: false, message: 'The assistant’s name cannot be changed here.' }),
  resetName: async () => ({ ok: false, message: 'The assistant’s name cannot be changed here.' }),
};

const AgentProfileContext = createContext<AgentProfileState>(FALLBACK);

/** Plain words for a failure, never a raw server string. */
export function describeProfileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') {
      return 'The service is unreachable, so the name was not saved.';
    }
    if (
      error.code === 'AGENT_NAME_INVALID' ||
      error.code === 'AGENT_NAME_TOO_LONG' ||
      error.code === 'OWNER_NAME_INVALID' ||
      error.code === 'OWNER_NAME_TOO_LONG'
    ) {
      return error.message;
    }
    return 'The name was not saved. Try again.';
  }
  return 'The name was not saved. Try again.';
}

export interface AgentProfileProviderProps {
  readonly children: ReactNode;
  /** Injection points for tests; the app passes nothing. */
  readonly client?: AgentProfileOptions;
}

export function AgentProfileProvider({ children, client }: AgentProfileProviderProps) {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const options = client;

  useEffect(() => {
    let cancelled = false;
    getAgentProfile(options)
      .then((response) => {
        if (cancelled) return;
        setProfile(response.profile);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // The header keeps showing the default rather than an empty title: a
        // failed read is not evidence the name changed.
        setError(describeProfileError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [options]);

  const save = useCallback(
    async (patch: { readonly agentName?: string; readonly ownerName?: string }) => {
      setSaving(true);
      try {
        const response = await updateAgentProfile(patch, options);
        setProfile(response.profile);
        setError(null);
        return { ok: true };
      } catch (cause) {
        return { ok: false, message: describeProfileError(cause) };
      } finally {
        setSaving(false);
      }
    },
    [options],
  );

  const resetName = useCallback(async () => {
    setSaving(true);
    try {
      const response = await resetAgentName(options);
      setProfile(response.profile);
      setError(null);
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: describeProfileError(cause) };
    } finally {
      setSaving(false);
    }
  }, [options]);

  const value = useMemo<AgentProfileState>(
    () => ({
      agentName: profile?.agentName ?? DEFAULT_AGENT_NAME,
      ownerName: profile?.ownerName ?? null,
      isDefault: profile?.isDefault ?? true,
      loading,
      error,
      saving,
      save,
      resetName,
    }),
    [profile, loading, error, saving, save, resetName],
  );

  return <AgentProfileContext.Provider value={value}>{children}</AgentProfileContext.Provider>;
}

export function useAgentProfile(): AgentProfileState {
  return useContext(AgentProfileContext);
}

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal async-resource loader with explicit states. Components render
 * loading/empty/error/success from one source of truth, and `reload` powers
 * retry buttons without remounting the page.
 */
export interface AsyncResource<T> {
  readonly state: 'loading' | 'ready' | 'error';
  readonly data: T | null;
  readonly error: unknown;
  reload(): void;
}

export function useAsyncResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): AsyncResource<T> {
  const [resource, setResource] = useState<{
    state: 'loading' | 'ready' | 'error';
    data: T | null;
    error: unknown;
  }>({ state: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setResource((previous) => ({
      state: 'loading',
      data: previous.data,
      error: null,
    }));
    loadRef
      .current()
      .then((data) => {
        if (!cancelled) setResource({ state: 'ready', data, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResource({ state: 'error', data: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...resource, reload };
}

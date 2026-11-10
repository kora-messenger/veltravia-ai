import { useEffect, useState } from 'react';

/**
 * Where the navigation stops sliding over the page and stands as its own column.
 *
 * Below this the panel is a drawer over the content; at or above it the very same
 * panel is the page's left column, so the desktop and the phone cannot drift into
 * two different designs. 1024px keeps a phone asking for the desktop site (980px)
 * on the drawer layout, where its rows are still comfortable.
 */
export const DOCKED_QUERY = '(min-width: 1024px)';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** Whether the navigation should stand docked rather than slide in. */
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(() => matches(DOCKED_QUERY));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DOCKED_QUERY);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return wide;
}

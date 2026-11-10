import { useEffect, useState } from 'react';

/**
 * Where the navigation stops sliding over the page and stands as its own column.
 *
 * Below this the panel is a drawer over the content; at or above it the very same
 * panel is the page's left column, so the desktop and the phone cannot drift into
 * two different designs.
 *
 * 901px is the shell's own breakpoint, the one that hides the top bar's hamburger
 * (shell.css), so the two cannot disagree: a window this wide always has the menu
 * standing open, and a narrower one always has the hamburger that opens it. The
 * earlier 1024 left 901-1023 with no navigation at all.
 */
export const DOCKED_QUERY = '(min-width: 901px)';

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

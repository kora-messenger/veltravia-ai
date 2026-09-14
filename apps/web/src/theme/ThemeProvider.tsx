import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme architecture.
 *
 * The user's PREFERENCE ('light' | 'dark' | 'system') is UI state and is
 * persisted locally; it is never credential material. The RESOLVED theme
 * ('light' | 'dark') is written as data-theme on <html>, so all styling flows
 * through CSS custom properties. When the preference is 'system', the
 * provider follows the OS color scheme live.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'veltravia.theme-preference';
const DATA_THEME_ATTRIBUTE = 'data-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface ThemeContextValue {
  /** The user's preference, exactly as chosen. */
  preference: ThemePreference;
  /** The concrete theme currently applied (data-theme on <html>). */
  theme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    preference === 'system' ? systemTheme() : (preference as ResolvedTheme),
  );

  // Follow the OS color scheme while the preference is 'system'.
  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(systemTheme());
    query.addEventListener('change', onChange);
    setTheme(systemTheme());
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  // Apply the resolved theme to the document root.
  useEffect(() => {
    document.documentElement.setAttribute(DATA_THEME_ATTRIBUTE, theme);
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; the theme still applies for this session.
    }
    setTheme(next === 'system' ? systemTheme() : next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme, setPreference }),
    [preference, theme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

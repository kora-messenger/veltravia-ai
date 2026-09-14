// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, isThemePreference, useTheme } from './ThemeProvider';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

function mockMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(query));
  return {
    setDark(value: boolean) {
      query.matches = value;
      for (const listener of listeners) listener();
    },
  };
}

function Probe() {
  const { preference, theme, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setPreference('dark')}>
        set-dark
      </button>
      <button type="button" onClick={() => setPreference('system')}>
        set-system
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it('defaults to the system preference and resolves a light theme', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('resolves dark when the system prefers dark', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies and persists an explicit preference', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'set-dark' }));
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('veltravia.theme-preference')).toBe('dark');
  });

  it('follows live system changes while the preference is system', () => {
    const media = mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      media.setDark(true);
    });
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('stops following the system after an explicit choice', () => {
    const media = mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'set-dark' }));
    act(() => {
      media.setDark(false);
    });
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('restores a stored preference', () => {
    window.localStorage.setItem('veltravia.theme-preference', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('isThemePreference', () => {
  it('accepts only known preferences', () => {
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('neon')).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

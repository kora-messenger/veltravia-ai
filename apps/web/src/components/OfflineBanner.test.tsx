// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OfflineBanner } from './OfflineBanner';
import { BackendNotice } from './BackendNotice';
import { DEFAULT_RUNTIME_CONFIG, setRuntimeConfig } from '../config/runtime-config';

/**
 * The two notices that stand between a lost phone connection and a screen that
 * looks broken. Both are quiet: a status region, never an alert, and nothing that
 * steals focus from what the user was doing.
 */
const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
};

afterEach(() => {
  cleanup();
  setOnline(true);
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('OfflineBanner', () => {
  it('renders nothing while the device is online', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByText(/No network connection/i)).toBeNull();
  });

  it('says so when the device goes offline', () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('No network connection'),
    );
  });

  it('reacts to the connection coming and going', () => {
    setOnline(true);
    render(<OfflineBanner />);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status').textContent).toMatch(/No network connection/);
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is a polite status region, not an alert', () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('BackendNotice', () => {
  it('stays silent in a browser, where the bundle is same-origin with the API', () => {
    render(<BackendNotice />);
    expect(screen.queryByText(/No backend configured/i)).toBeNull();
  });

  it('explains a packaged build that has no backend URL', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    setRuntimeConfig({ apiBaseUrl: '' });
    render(<BackendNotice />);
    expect(screen.getByRole('status').textContent).toMatch(/No backend configured/i);
  });

  it('stays silent in a packaged build that does have one', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    setRuntimeConfig({ apiBaseUrl: 'https://api.example.com' });
    render(<BackendNotice />);
    expect(screen.queryByText(/No backend configured/i)).toBeNull();
  });
});

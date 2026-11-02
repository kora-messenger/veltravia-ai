import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android application wraps the REAL Veltravia web build.
 *
 * There is no second frontend: `webDir` points at the compiled React application
 * in `apps/web/dist`, so every screen, drawer, dialog and route the browser gets
 * is the same code the phone gets.
 *
 * The backend is never localhost. The packaged application reads its backend URL
 * from `public/runtime-config.json` inside the web bundle, which the Android
 * workflow writes from a repository variable before the build. A missing value
 * makes the application say so on screen instead of silently failing to connect.
 */
const config: CapacitorConfig = {
  appId: 'com.veltravia.ai',
  appName: 'Veltravia AI',
  webDir: '../web/dist',
  bundledWebRuntime: false,
  android: {
    // The web build is served from https://localhost inside the WebView, so the
    // page keeps a secure origin and cannot be mixed with plain http requests.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
};

export default config;

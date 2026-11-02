import { backendReachable, isPackagedApp, runtimeConfig } from '../config/runtime-config';

/**
 * Says plainly that this build has no backend to talk to.
 *
 * A packaged application cannot fall back to a same-origin API: the bundle lives
 * inside the APK. If the build was made without a backend URL, every screen would
 * otherwise show an empty list and look broken. This states the reason once, at
 * the top of the shell, and tells the developer what to configure.
 */
export function BackendNotice() {
  if (!isPackagedApp() || backendReachable()) return null;
  return (
    <div className="v-backend-notice" role="status" aria-live="polite">
      <strong>No backend configured.</strong> This build was packaged without a backend URL, so
      nothing can load. Set the API base URL in the Android workflow (or
      <code> scripts/write-runtime-config.mjs &quot;https://your-backend&quot;</code>) and rebuild.
      {runtimeConfig().apiBaseUrl === '' ? null : null}
    </div>
  );
}

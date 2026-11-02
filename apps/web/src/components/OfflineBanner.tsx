import { useEffect, useState } from 'react';

/**
 * Says so when the device has no network.
 *
 * A packaged application is used on a phone, where the connection drops in a
 * lift or on a train. Without this the app simply stops answering and the user
 * cannot tell a slow model from a dead network. It reads the browser's own
 * connectivity signal, which the Android WebView also maintains, so it needs no
 * plugin and no permission.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
      ? true
      : navigator.onLine,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setOnline(typeof navigator.onLine === 'boolean' ? navigator.onLine : true);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    // A device can report a stale state on resume from sleep.
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return online;
}

/**
 * A persistent, polite notice. It is a `status` region rather than an alert:
 * losing the network is not an emergency, and it must not steal focus.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="v-offline-banner" role="status" aria-live="polite">
      No network connection. Requests will fail until this device is back online.
    </div>
  );
}

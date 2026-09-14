import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss delay in ms; 0 keeps the toast until dismissed. */
  duration?: number;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast(message: string, options?: ToastOptions): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

/**
 * Toast notifications: polite live region, dismiss button, optional
 * auto-dismiss. Timers are cleaned up on unmount of the provider.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = nextId.current;
      nextId.current += 1;
      const tone = options.tone ?? 'info';
      setToasts((current) => [...current, { id, message, tone }]);
      const duration = options.duration ?? DEFAULT_DURATION_MS;
      if (duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), duration);
        timers.current.push(timer);
      }
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="v-toaster" role="region" aria-label="Notifications">
        <ol className="v-toaster__list" aria-live="polite">
          {toasts.map((entry) => (
            <li key={entry.id} className={`v-toast v-toast--${entry.tone}`} role="status">
              <span className="v-toast__message">{entry.message}</span>
              <button
                type="button"
                className="v-toast__close"
                aria-label="Dismiss notification"
                onClick={() => dismiss(entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface WorkspaceDrawerProps {
  open: boolean;
  onClose(): void;
  /** Accessible name for the drawer panel. */
  label: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Mobile side panel for the workspace. On small screens the project
 * context and activity panels become drawers: backdrop + Escape close +
 * focus moves into the panel and returns to the trigger on close.
 */
export function WorkspaceDrawer({ open, onClose, label, children }: WorkspaceDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || panelRef.current === null) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable[0] ?? panel).focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const restore = restoreFocusRef.current;
      if (restore instanceof HTMLElement) restore.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="v-wdrawer">
      <div className="v-wdrawer__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="v-wdrawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="v-wdrawer__header">
          <h2 className="v-wdrawer__title" id={titleId}>
            {label}
          </h2>
          <button type="button" className="v-wdrawer__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="v-wdrawer__body">{children}</div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  /** Dialog content. */
  children?: ReactNode;
  /** Action row (usually Buttons). */
  footer?: ReactNode;
  /** Width preset for the dialog. */
  size?: 'sm' | 'md';
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: portal-rendered, focus-trapped, Escape closes,
 * background scroll locked, focus restored to the previously focused element.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      if (first === undefined) return;
      const last = focusable[focusable.length - 1];
      if (last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown, true);
    // Move initial focus into the dialog.
    window.setTimeout(() => {
      const panel = dialogRef.current;
      if (panel === null) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const target = focusable[0] ?? panel;
      target.focus();
    }, 0);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown, true);
      const previous = previouslyFocused.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div
      className="v-dialog__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        className={size === 'sm' ? 'v-dialog v-dialog--sm' : 'v-dialog'}
        tabIndex={-1}
      >
        <header className="v-dialog__header">
          <div>
            <h2 className="v-dialog__title" id={titleId}>
              {title}
            </h2>
            {description !== undefined && (
              <p className="v-caption v-dialog__description" id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          <IconButton aria-label="Close dialog" onClick={onClose} size="sm">
            <svg className="v-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </IconButton>
        </header>
        {children !== undefined && <div className="v-dialog__body">{children}</div>}
        {footer !== undefined && <footer className="v-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

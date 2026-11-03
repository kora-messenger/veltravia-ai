import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface MenuItemDef {
  id: string;
  label: string;
  /** Runs when the row is chosen. A row with children opens them instead. */
  onSelect?(): void | boolean;
  icon?: ReactNode;
  /** Short trailing note, e.g. why an item is not usable yet. Read by AT. */
  hint?: string;
  disabled?: boolean;
  /**
   * A second level. The row then carries a caret and, when chosen, the panel
   * shows these rows with one way back. Used where one label groups several
   * actions, as "Add note" groups the notes already written.
   */
  children?: readonly MenuItemDef[];
}

/**
 * Where the panel opens from its trigger.
 *
 * `below-end` is the default for a control in a bar. `above-start` is for a
 * trigger at the bottom-left of the screen, such as the composer's plus: opening
 * downwards there would put the panel off the bottom edge, and aligning to the
 * trigger's right edge would push it off the left.
 */
export type MenuPlacement = 'below-end' | 'above-start';

export interface MenuProps {
  /** The trigger element (rendered as-is inside a button). */
  trigger: ReactNode;
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  items: readonly MenuItemDef[];
  readonly placement?: MenuPlacement;
}

/**
 * Accessible dropdown menu: aria-haspopup/aria-expanded wiring, arrow/Home/End
 * keyboard navigation, Escape closes and restores focus to the trigger,
 * click-outside closes.
 */
export function Menu({ trigger, triggerLabel, items, placement = 'below-end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The path into a second level, empty at the top.
  const [trail, setTrail] = useState<readonly MenuItemDef[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    setTrail([]);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  /** The rows actually on screen: the top level, or the open second level. */
  const parent = trail[trail.length - 1];
  const visible: readonly MenuItemDef[] = parent?.children !== undefined ? parent.children : items;
  // A second level opens with a way back, so the keyboard can always leave it.
  const rows: readonly MenuItemDef[] =
    trail.length === 0
      ? visible
      : [
          {
            id: '__back',
            label: `Back to ${parent?.label ?? 'the menu'}`,
            onSelect: () => {
              setTrail((current) => current.slice(0, -1));
              setActiveIndex(0);
              // Stepping back leaves the panel open: closing it here would hide
              // the rows the person just asked to return to.
              return true;
            },
          },
          ...visible,
        ];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(event.target as Node) &&
        triggerRef.current !== null &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    // Escape is handled at the document, not only inside the panel: the trigger
    // keeps focus when the menu opens, and a panel that covers its own trigger
    // leaves the keyboard user with no way back otherwise.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(event.key === 'ArrowDown' ? 0 : rows.length - 1);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(rows.length - 1);
    }
  };

  return (
    <div className="v-menu">
      <button
        ref={triggerRef}
        type="button"
        className="v-menu__trigger v-button v-button--ghost v-button--md"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => {
          if (open) {
            close(true);
          } else {
            setOpen(true);
            setActiveIndex(0);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          id={menuId}
          aria-label={triggerLabel}
          className={
            placement === 'above-start'
              ? 'v-menu__panel v-menu__panel--above-start'
              : 'v-menu__panel'
          }
          onKeyDown={handleMenuKeyDown}
        >
          {rows.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={
                index === activeIndex ? 'v-menu__item v-menu__item--active' : 'v-menu__item'
              }
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              aria-haspopup={item.children !== undefined ? 'menu' : undefined}
              onClick={() => {
                if (item.disabled) return;
                if (item.children !== undefined) {
                  setTrail((current) => [...current, item]);
                  setActiveIndex(0);
                  return;
                }
                // Returning true means "stay open": a row that changes the panel
                // rather than acting has not finished the person's errand.
                if (item.onSelect?.() === true) return;
                close(true);
              }}
            >
              {item.icon !== undefined && <span className="v-menu__item-icon">{item.icon}</span>}
              <span className="v-menu__item-label">{item.label}</span>
              {item.hint !== undefined && <span className="v-menu__hint">{item.hint}</span>}
              {item.children !== undefined && (
                <span className="v-menu__caret" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                    <path
                      d="M5 10l3-3 3 3"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  onSelect(): void;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface MenuProps {
  /** The trigger element (rendered as-is inside a button). */
  trigger: ReactNode;
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  items: readonly MenuItemDef[];
}

/**
 * Accessible dropdown menu: aria-haspopup/aria-expanded wiring, arrow/Home/End
 * keyboard navigation, Escape closes and restores focus to the trigger,
 * click-outside closes.
 */
export function Menu({ trigger, triggerLabel, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

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
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(event.key === 'ArrowDown' ? 0 : items.length - 1);
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
      if (items.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + delta + items.length) % items.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(items.length - 1);
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
          className="v-menu__panel"
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={
                index === activeIndex ? 'v-menu__item v-menu__item--active' : 'v-menu__item'
              }
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                close(true);
              }}
            >
              {item.icon !== undefined && <span className="v-menu__item-icon">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

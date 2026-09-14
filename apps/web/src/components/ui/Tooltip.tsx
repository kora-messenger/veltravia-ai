import { useId, type ReactNode } from 'react';

export interface TooltipProps {
  /** Tooltip text (plain text only — it is announced, not read as a link). */
  text: string;
  children: ReactNode;
}

/**
 * CSS-driven tooltip: visible on hover AND keyboard focus, announced via
 * aria-describedby. The wrapper is inline so it works next to any control.
 */
export function Tooltip({ text, children }: TooltipProps) {
  const id = useId();
  return (
    <span className="v-tooltip">
      <span className="v-tooltip__target" aria-describedby={id} tabIndex={0}>
        {children}
      </span>
      <span role="tooltip" id={id} className="v-tooltip__bubble">
        {text}
      </span>
    </span>
  );
}

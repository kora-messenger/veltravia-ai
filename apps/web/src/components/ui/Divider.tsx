import type { HTMLAttributes } from 'react';

type DividerOrientation = 'horizontal' | 'vertical';

export interface DividerProps extends HTMLAttributes<HTMLElement> {
  orientation?: DividerOrientation;
  /** Renders a non-decorative <hr> when the divider separates content. */
  decorative?: boolean;
}

export function Divider({ orientation = 'horizontal', decorative = false, ...rest }: DividerProps) {
  const className = orientation === 'vertical' ? 'v-divider v-divider--vertical' : 'v-divider';
  return decorative === true ? (
    <div className={className} role="presentation" {...rest} />
  ) : (
    <hr className={className} {...rest} />
  );
}

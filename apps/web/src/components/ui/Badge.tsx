import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'primary';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Compact dot badges carry no text; the label still announces. */
  dot?: boolean;
  children?: ReactNode;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'v-badge--neutral',
  success: 'v-badge--success',
  warning: 'v-badge--warning',
  error: 'v-badge--error',
  info: 'v-badge--info',
  primary: 'v-badge--primary',
};

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={['v-badge', TONE_CLASS[tone], className].filter(Boolean).join(' ')} {...rest}>
      {dot && <span className="v-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

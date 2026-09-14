import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon buttons are identified by their accessible label. */
  'aria-label': string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
  children: ReactNode;
}

export function IconButton({
  variant = 'ghost',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: IconButtonProps) {
  const classes = [
    'v-icon-button',
    variant === 'primary'
      ? 'v-button--primary'
      : variant === 'secondary'
        ? 'v-button--secondary'
        : 'v-button--ghost',
    size === 'sm' ? 'v-icon-button--sm' : 'v-icon-button--md',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" /> : children}
    </button>
  );
}

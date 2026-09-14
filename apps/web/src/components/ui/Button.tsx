import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables interaction, and announces a busy state. */
  loading?: boolean;
  /** Leading visual (icon). */
  leading?: ReactNode;
  /** Trailing visual (icon). */
  trailing?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'v-button--primary',
  secondary: 'v-button--secondary',
  ghost: 'v-button--ghost',
  danger: 'v-button--danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'v-button--sm',
  md: 'v-button--md',
  lg: 'v-button--lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leading,
  trailing,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['v-button', VARIANT_CLASS[variant], SIZE_CLASS[size], className]
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
      {loading ? (
        <Spinner size="sm" />
      ) : (
        leading !== undefined && <span className="v-button__icon">{leading}</span>
      )}
      {children}
      {trailing !== undefined && <span className="v-button__icon">{trailing}</span>}
    </button>
  );
}

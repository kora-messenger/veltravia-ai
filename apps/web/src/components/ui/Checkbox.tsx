import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  /** Checkbox text (the accessible label). */
  label: ReactNode;
  hint?: string;
  error?: string;
}

export function Checkbox({
  label,
  hint,
  error,
  required,
  disabled,
  className,
  ...rest
}: CheckboxProps) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy =
    error !== undefined
      ? hint !== undefined
        ? `${errorId} ${hintId}`
        : errorId
      : hint !== undefined
        ? hintId
        : undefined;

  return (
    <div
      className={
        error !== undefined
          ? 'v-checkbox v-checkbox--error'
          : 'v-checkbox' + (className ? ` ${className}` : '')
      }
    >
      <input
        id={id}
        type="checkbox"
        className="v-checkbox__control"
        required={required}
        disabled={disabled}
        aria-describedby={describedBy}
        {...rest}
      />
      <label className="v-checkbox__label" htmlFor={id}>
        {label}
      </label>
      {error !== undefined ? (
        <p className="v-field__error" id={errorId}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="v-caption v-field__hint" id={hintId}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

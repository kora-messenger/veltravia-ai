import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label?: string;
  /** Helper text rendered below the field. */
  hint?: ReactNode;
  /** Error message; also wires aria-invalid/aria-describedby. */
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function Input({
  label,
  hint,
  error,
  leading,
  trailing,
  required,
  disabled,
  className,
  ...rest
}: InputProps) {
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
    <div className={disabled === true ? 'v-field v-field--disabled' : 'v-field'}>
      {label !== undefined && (
        <label className="v-label v-field__label" htmlFor={id}>
          {label}
          {required === true && (
            <span className="v-field__required" aria-hidden="true">
              {' *'}
            </span>
          )}
        </label>
      )}
      <div
        className={
          error !== undefined
            ? 'v-input v-input--error'
            : 'v-input' + (className ? ` ${className}` : '')
        }
      >
        {leading !== undefined && <span className="v-input__affix">{leading}</span>}
        <input
          id={id}
          className="v-input__control"
          required={required}
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {trailing !== undefined && <span className="v-input__affix">{trailing}</span>}
      </div>
      {error !== undefined && (
        <p className="v-field__error" id={errorId}>
          {error}
        </p>
      )}
      {error === undefined && hint !== undefined && (
        <p className="v-caption v-field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

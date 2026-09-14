import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label?: string;
  hint?: string;
  error?: string;
  options: readonly SelectOption[];
  /** Placeholder option (empty value). */
  placeholder?: string;
  trailing?: ReactNode;
}

export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  required,
  disabled,
  className,
  ...rest
}: SelectProps) {
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
            ? 'v-select v-select--error'
            : 'v-select' + (className ? ` ${className}` : '')
        }
      >
        <select
          id={id}
          className="v-select__control"
          required={required}
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy}
          {...rest}
        >
          {placeholder !== undefined && (
            <option value="" disabled={required}>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="v-select__chevron" aria-hidden="true">
          ▾
        </span>
      </div>
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

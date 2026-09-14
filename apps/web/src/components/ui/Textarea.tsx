import { useId, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Textarea({
  label,
  hint,
  error,
  required,
  disabled,
  rows = 4,
  className,
  ...rest
}: TextareaProps) {
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
      <textarea
        id={id}
        className={
          error !== undefined
            ? 'v-textarea v-textarea--error'
            : 'v-textarea' + (className ? ` ${className}` : '')
        }
        rows={rows}
        required={required}
        disabled={disabled}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        {...rest}
      />
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

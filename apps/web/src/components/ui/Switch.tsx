import { useId, type ReactNode } from 'react';

export interface SwitchProps {
  /** Switch text (the accessible label). */
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: string;
  disabled?: boolean;
  name?: string;
}

/**
 * A switch built on a native checkbox exposed with role="switch":
 * keyboard-operable and announced correctly by screen readers.
 */
export function Switch({ label, checked, onChange, hint, disabled, name }: SwitchProps) {
  const id = useId();
  const hintId = useId();

  return (
    <div className={disabled === true ? 'v-switch v-switch--disabled' : 'v-switch'}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint !== undefined ? hintId : undefined}
        disabled={disabled}
        className={checked ? 'v-switch__track v-switch__track--on' : 'v-switch__track'}
        onClick={() => onChange(!checked)}
      >
        <span className={checked ? 'v-switch__thumb v-switch__thumb--on' : 'v-switch__thumb'} />
      </button>
      <label className="v-switch__label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined && (
        <p className="v-caption v-switch__hint" id={hintId}>
          {hint}
        </p>
      )}
      {name !== undefined && <input type="hidden" name={name} value={String(checked)} />}
    </div>
  );
}

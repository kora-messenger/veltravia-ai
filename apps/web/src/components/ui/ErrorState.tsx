import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  /** Optional retry action. */
  retry?: { label?: string; onClick(): void };
  /** Shows a pending indicator instead of the retry button. */
  retrying?: boolean;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'An unexpected error occurred. Try again.',
  retry,
  retrying = false,
}: ErrorStateProps) {
  return (
    <div className="v-error-state" role="alert">
      <div className="v-error-state__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path
            d="M12 8.5v5m0 3.4v.1m-9.2-1.4L10.6 4.6a1.6 1.6 0 0 1 2.8 0l7.8 11a1.6 1.6 0 0 1-1.4 2.4H4.2a1.6 1.6 0 0 1-1.4-2.4Z"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
          />
        </svg>
      </div>
      <h3 className="v-error-state__title">{title}</h3>
      <p className="v-error-state__description">{description}</p>
      {retry !== undefined && (
        <Button variant="secondary" onClick={retry.onClick} loading={retrying}>
          {retry.label ?? 'Retry'}
        </Button>
      )}
    </div>
  );
}

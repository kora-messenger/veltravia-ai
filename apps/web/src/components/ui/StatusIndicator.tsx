export type StatusTone = 'online' | 'offline' | 'pending' | 'error';

export interface StatusIndicatorProps {
  tone: StatusTone;
  /** Status text shown next to the dot (also the accessible label). */
  label: string;
}

const TONE_CLASS: Record<StatusTone, string> = {
  online: 'v-status--online',
  offline: 'v-status--offline',
  pending: 'v-status--pending',
  error: 'v-status--error',
};

export function StatusIndicator({ tone, label }: StatusIndicatorProps) {
  return (
    <span className={['v-status', TONE_CLASS[tone]].join(' ')}>
      <span className="v-status__dot" aria-hidden="true" />
      <span className="v-status__label">{label}</span>
    </span>
  );
}

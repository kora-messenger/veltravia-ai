export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Accessible label; defaults to "Loading". */
  'aria-label'?: string;
}

const STROKE_WIDTH = 3;
const SIZES: Record<SpinnerSize, number> = { sm: 14, md: 20, lg: 32 };

export function Spinner({ size = 'md', 'aria-label': label = 'Loading' }: SpinnerProps) {
  const box = SIZES[size];
  return (
    <svg
      className="v-spinner"
      width={box}
      height={box}
      viewBox="0 0 24 24"
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <circle
        className="v-spinner__track"
        cx="12"
        cy="12"
        r={12 - STROKE_WIDTH}
        fill="none"
        strokeWidth={STROKE_WIDTH}
      />
      <circle
        className="v-spinner__arc"
        cx="12"
        cy="12"
        r={12 - STROKE_WIDTH}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        strokeDasharray="42"
        strokeDashoffset="28"
        strokeLinecap="round"
      />
    </svg>
  );
}

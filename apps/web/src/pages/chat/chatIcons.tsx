/**
 * Icons for the chat surface. Thin single-stroke line work, drawn inline so the
 * bundle carries no icon font and every mark inherits `currentColor`.
 */

export interface IconProps {
  readonly size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
});

export function PlusIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MicIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function TuneIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2.2" />
      <circle cx="10" cy="16" r="2.2" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PencilIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20Z" />
      <path d="M14.2 6.6l3.2 3.2" />
    </svg>
  );
}

export function DocumentIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

export function PhoneIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6.5 3h3l1.5 4-2 1.5a11 11 0 0 0 5.5 5.5L16 12l4 1.5v3A2.5 2.5 0 0 1 17.5 19C10.6 18.6 5.4 13.4 5 6.5A2.5 2.5 0 0 1 6.5 3z" />
    </svg>
  );
}

export function TargetIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.4" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M4 12h13M11 6l6 6-6 6" />
    </svg>
  );
}

/** Two strokes turning back on themselves: a fresh conversation. */
export function NewChatIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 12a8 8 0 1 1-3.2-6.4" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

export function ChevronIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 5l6 7-6 7" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 12.5l4.5 4.5L19 6.5" />
    </svg>
  );
}

export function CrossIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PauseIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

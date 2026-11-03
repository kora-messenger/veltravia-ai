import { useId } from 'react';

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

/**
 * The voice mark: a short equaliser. Used on the filled control that stands in
 * the send position while there is nothing to send, so the control is a voice
 * control rather than a dead send button.
 */
/** The retry mark: an open circular arrow, used by the failed-turn control. */
export function RetryIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" />
    </svg>
  );
}

export function WaveIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M5 10v4M9 6v12M13 8v8M17 10v4M21 11v2" />
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

/**
 * A code mark: the `</>` a command step wears. Thin strokes, inherits colour, so
 * it sits in the same optical weight as the rest of the thread.
 */
export function CodeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
    </svg>
  );
}

export type ChipState = 'done' | 'failed' | 'refused';

/**
 * A status chip: a solid block with the mark punched out of it, not drawn on top.
 * The reference does the same, and it matters: a mark drawn over a fill reads as
 * two shapes, while a knockout reads as one object that has a hole in it.
 *
 * The hole is a real hole. The block is filled with `currentColor` through an SVG
 * mask whose glyph is black, so whatever sits behind the chip - the page, a hover
 * tint - shows through the mark instead of being covered by a second colour.
 */
export function StatusChip({ state, size = 16 }: IconProps & { readonly state: ChipState }) {
  const maskId = `v-chip-${useId().replace(/:/g, '')}`;
  const glyph =
    state === 'done' ? (
      <path d="M6.9 12.4l3.2 3.2 7-7.4" />
    ) : (
      <path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" />
    );
  return (
    <svg {...base(size)} aria-hidden="true">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect x="0" y="0" width="24" height="24" fill="#fff" />
          <g
            stroke="#000"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            {glyph}
          </g>
        </mask>
      </defs>
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="5"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

/** Two offset sheets: the copy mark, the same shape the reference uses. */
export function CopyIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2.4" />
      <path d="M15 5.6A1.6 1.6 0 0 0 13.4 4H5.6A1.6 1.6 0 0 0 4 5.6v7.8A1.6 1.6 0 0 0 5.6 15" />
    </svg>
  );
}

/** A thumbs-up outline: one answer was useful. */
export function ThumbUpIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 10.5V20M7 10.5 10.6 3a2.4 2.4 0 0 1 2.4 2.4V9h4.4a2 2 0 0 1 2 2.4l-1.2 6.6a2 2 0 0 1-2 1.6H7" />
    </svg>
  );
}

/** The same thumb, turned over. */
export function ThumbDownIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M17 13.5V4M17 13.5 13.4 21a2.4 2.4 0 0 1-2.4-2.4V15H6.6a2 2 0 0 1-2-2.4l1.2-6.6a2 2 0 0 1 2-1.6H17" />
    </svg>
  );
}

/** A speaker with two arcs: read this aloud. */
export function SpeakerIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4" />
    </svg>
  );
}

/** An arrow leaving an open box: hand this answer to another app. */
export function ShareIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3.5v10M8.5 7 12 3.5 15.5 7" />
      <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </svg>
  );
}

/** A picture in a frame: attach a photo. */
export function PhotoIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <circle cx="8.6" cy="9.6" r="1.6" />
      <path d="M21 15.5 16.4 11 6 20.4" />
    </svg>
  );
}

/** A folder: the projects list. */
export function FolderIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7.4A1.9 1.9 0 0 1 4.9 5.5h4l2 2.6h8.2A1.9 1.9 0 0 1 21 10v7.6a1.9 1.9 0 0 1-1.9 1.9H4.9A1.9 1.9 0 0 1 3 17.6Z" />
    </svg>
  );
}

/** Four tiles: the app builder. */
export function BuilderIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </svg>
  );
}

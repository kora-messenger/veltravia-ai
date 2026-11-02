/**
 * The owner's picture, as the circle beside their own turns.
 *
 * There are no accounts in this build, so there is no photograph to fetch: the
 * circle falls back to the first letter of the name they gave in the agent
 * dialog, and to a person glyph when they have given no name. One letter, not
 * two: "Ijezie Nwosu" is I. When an account photo exists later, `src` is the only
 * thing that has to change.
 */

export interface UserAvatarProps {
  readonly name: string | null;
  readonly src?: string | null;
  readonly size?: number;
}

/**
 * The first letter of the name, by code point so a name starting with an emoji
 * works. One letter only: the circle marks who sent the turn, and a second
 * letter made "Ijezie Nwosu" read like two people.
 */
export function initialFrom(name: string | null): string | null {
  if (name === null) return null;
  const first = [...name.trim()][0] ?? '';
  if (first === '' || /\s/.test(first)) return null;
  return first.toUpperCase();
}

function PersonGlyph({ size }: { readonly size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

export function UserAvatar({ name, src = null, size = 28 }: UserAvatarProps) {
  const initial = initialFrom(name);
  return (
    <span
      className="v-chat__avatar"
      style={{ inlineSize: `${size}px`, blockSize: `${size}px` }}
      /* Decorative: the turn is already the owner's, so announcing "you" again
         on every message would only add noise. */
      aria-hidden="true"
      data-empty={initial === null ? 'true' : undefined}
    >
      {src !== null ? (
        <img className="v-chat__avatar-image" src={src} alt="" decoding="async" />
      ) : initial !== null ? (
        initial
      ) : (
        <PersonGlyph size={Math.round(size * 0.55)} />
      )}
    </span>
  );
}

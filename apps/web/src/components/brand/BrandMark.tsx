import type { CSSProperties } from 'react';

/**
 * The Veltravia mark, drawn from the delivered artwork.
 *
 * Measured on the supplied files (scripts/trim-brand-assets.py records this in
 * brand-assets.json): the logo keeps its ink inside 64% x 51% of the 1024
 * square, so drawing it directly produced a 17 x 14px shape inside a 28px box.
 * The shipped files are therefore cropped to the ink and re-centred with 7%
 * breathing room; the artwork itself is untouched (no recolour, no per-axis
 * scale, alpha preserved) and the originals ship alongside at their full size.
 *
 * The mark is drawn on a transparent background by request: no chip, no grey
 * box, so the artwork sits directly on the surface behind it. About 6.6% of the
 * mark's opaque pixels are its near-white highlights, so those highlights read
 * faintly on the light theme; the violet body, which carries the shape, does not
 * depend on them. Sizes are square and follow the asset's own proportions.
 */

export type BrandVariant = 'logo' | 'notification';

export interface BrandMarkProps {
  /** `logo` is the full lockup; `notification` is the status mark. */
  readonly variant?: BrandVariant;
  /** Rendered square, in CSS pixels. */
  readonly size?: number;
  /** Decorative use (the wordmark already names the product) hides it from AT. */
  readonly decorative?: boolean;
  readonly className?: string;
}

interface BrandSource {
  /** Fallback for browsers without srcset support. */
  readonly src: string;
  /** Density descriptors, so a 3x display gets a 3x file, not an upscale. */
  readonly srcSet: string;
}

/**
 * Where a brand file lives, resolved against the page itself.
 *
 * The artwork sits in `public/`, which the bundler copies verbatim: it rewrites
 * the paths written in `index.html`, never the ones written in code. A
 * root-absolute `/brand/...` therefore asks the server root for the file, and
 * this build is served from a sub-path (GitHub Pages: `/veltravia-ai/`), so the
 * mark 404'd and rendered as a broken image on the live site.
 *
 * The base is the document's own URI rather than a build variable: the frontend
 * reads no environment at all (workspace-boundary.test.ts enforces that, so no
 * credential can reach the bundle), and the document already knows where it is
 * served from. The folder it lives in is what the file is joined to, so a base
 * that arrives without its trailing slash still points inside the same folder.
 */
export function brandUrl(file: string, base: string): string {
  const folder = base.endsWith('/') ? base : `${base}/`;
  return new URL(`brand/${file}`, folder).toString();
}

function pageBase(): string {
  // Server-side rendering has no document; nothing is drawn there either, but a
  // relative base keeps the call total.
  return typeof document === 'undefined' ? '/' : document.baseURI;
}

function source(variant: BrandVariant): BrandSource {
  const base = pageBase();
  const files: ReadonlyArray<readonly [string, string]> =
    variant === 'logo'
      ? [
          ['veltravia-logo-96.png', '1x'],
          ['veltravia-logo-192.png', '2x'],
          ['veltravia-logo-512.png', '3x'],
        ]
      : [
          ['veltravia-notification-96.png', '1x'],
          ['veltravia-notification-256.png', '2x'],
        ];
  const main = variant === 'logo' ? 'veltravia-logo-192.png' : 'veltravia-notification-96.png';
  return {
    src: brandUrl(main, base),
    srcSet: files.map(([name, density]) => `${brandUrl(name, base)} ${density}`).join(', '),
  };
}

const LABEL: Record<BrandVariant, string> = {
  logo: 'Veltravia AI',
  notification: 'Veltravia AI notifications',
};

export function BrandMark({
  variant = 'logo',
  size = 28,
  decorative = false,
  className,
}: BrandMarkProps) {
  const style: CSSProperties = { '--brand-mark-size': `${size}px` } as CSSProperties;
  return (
    <span
      className={['v-brand-mark', className].filter(Boolean).join(' ')}
      style={style}
      data-variant={variant}
    >
      <img
        className="v-brand-mark__image"
        src={source(variant).src}
        srcSet={source(variant).srcSet}
        width={size}
        height={size}
        alt={decorative ? '' : LABEL[variant]}
        {...(decorative ? { 'aria-hidden': 'true' } : {})}
        decoding="async"
      />
    </span>
  );
}

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
 * The artwork mixes deep violet with white highlights, so it is always mounted
 * on a dark chip: on a light surface the white highlights would disappear, and
 * on the dark surface the chip keeps the mark's own edges crisp in both themes.
 * Sizes are square and follow the asset's own proportions.
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

const SOURCE: Record<BrandVariant, BrandSource> = {
  logo: {
    src: '/brand/veltravia-logo-192.png',
    srcSet:
      '/brand/veltravia-logo-96.png 1x, /brand/veltravia-logo-192.png 2x, /brand/veltravia-logo-512.png 3x',
  },
  notification: {
    src: '/brand/veltravia-notification-96.png',
    srcSet: '/brand/veltravia-notification-96.png 1x, /brand/veltravia-notification-256.png 2x',
  },
};

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
        src={SOURCE[variant].src}
        srcSet={SOURCE[variant].srcSet}
        width={size}
        height={size}
        alt={decorative ? '' : LABEL[variant]}
        {...(decorative ? { 'aria-hidden': 'true' } : {})}
        decoding="async"
      />
    </span>
  );
}

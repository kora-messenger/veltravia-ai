import type { CSSProperties } from 'react';

/**
 * The supplied Veltravia assets, used as they were delivered.
 *
 * Both files are transparent PNGs whose artwork includes white type, so a logo
 * placed straight on a light surface would lose the wordmark. The mark is
 * therefore mounted on a fixed dark tile: the artwork is never recoloured,
 * cropped or stretched, and it stays legible in light, dark and system themes.
 * Sizes are square and taken from the asset's own proportions.
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

const SOURCE: Record<BrandVariant, string> = {
  logo: '/brand/veltravia-logo.png',
  notification: '/brand/veltravia-notification-256.png',
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
        src={SOURCE[variant]}
        width={size}
        height={size}
        alt={decorative ? '' : LABEL[variant]}
        {...(decorative ? { 'aria-hidden': 'true' } : {})}
        decoding="async"
      />
    </span>
  );
}

import { BrandMark } from '../../components/brand/BrandMark';

export interface WebLandingProps {
  readonly name: string | null;
}

/**
 * The website's empty state: the mark and a greeting, and nothing else.
 *
 * The two ways in used to sit here, under the greeting. They live against the
 * type box now (see QuickPrompts), which is where the reference keeps them, so
 * this screen is only ever the welcome: mark, greeting, then the box.
 */
export function WebLanding({ name }: WebLandingProps) {
  return (
    <div className="v-chat__hero">
      <BrandMark size={56} decorative />
      <h1 className="v-chat__greeting">
        {name === null ? 'Hey there,' : `Hey ${name},`}
        <span className="v-chat__greeting-line">what should we build?</span>
      </h1>
    </div>
  );
}

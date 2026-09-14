import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Renders the whole card as a single link/button container. */
  as?: 'div' | 'section' | 'article';
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Extra visual emphasis (shadow + border). */
  raised?: boolean;
  children?: ReactNode;
}

export function Card({
  as: Tag = 'div',
  title,
  description,
  actions,
  footer,
  raised = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={['v-card', raised ? 'v-card--raised' : '', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="v-card__header">
          <div className="v-card__heading">
            {title !== undefined && <h3 className="v-card__title">{title}</h3>}
            {description !== undefined && <p className="v-card__description">{description}</p>}
          </div>
          {actions !== undefined && <div className="v-card__actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="v-card__body">{children}</div>}
      {footer !== undefined && <footer className="v-card__footer">{footer}</footer>}
    </Tag>
  );
}

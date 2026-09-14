import type { ReactNode } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional primary action. */
  action?: { label: string; onClick(): void; disabled?: boolean };
  /** Optional visual (icon) rendered above the title. */
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="v-empty">
      {icon !== undefined && <div className="v-empty__icon">{icon}</div>}
      <h3 className="v-empty__title">{title}</h3>
      {description !== undefined && <p className="v-empty__description">{description}</p>}
      {action !== undefined && (
        <Button onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

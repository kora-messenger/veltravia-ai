import { type ReactNode } from 'react';
import { Button, Dialog } from '../../components/ui';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmTone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
}

/** Small confirmation dialog for consequential actions (archive/restore). */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmTone = 'primary',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={confirmTone} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{description}</p>
    </Dialog>
  );
}

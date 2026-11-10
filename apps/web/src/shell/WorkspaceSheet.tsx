import { useEffect, useRef, useState } from 'react';
import { getMessageCreditSummary, type MessageCreditSummary } from '../api/message-credits';
import { workspaceInitials } from './workspace-initials';

/**
 * The bottom sheet the drawer's profile line opens.
 *
 * Measured from a screen recording of the reference (1080 x 2400 capture, 2.628
 * px per dp): the sheet rises from the bottom in about 180ms, a 4dp grab handle
 * on top, then the workspace line, the credit card, and the workspace actions.
 *
 * Everything on it is real or absent. The reference also offers "Earn free
 * credits", "Add members", a profile and an affiliate row; Veltravia has no
 * referral programme, no teams and no accounts yet, so those rows are not drawn
 * rather than drawn dead. The credit card reads `/api/message-credits`, and while
 * that is in flight shows the reference's loading state: grey blocks that breathe
 * between two tones, with no travelling highlight (the recording shows none).
 */

export type CreditState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly summary: MessageCreditSummary }
  | { readonly kind: 'error' };

export interface CreditMeter {
  readonly label: string;
  /** What is shown at the right of the label, e.g. "87.33/235". */
  readonly figure: string;
  /** 0 to 1, or null for a row that has no bar. */
  readonly fraction: number | null;
  readonly tone: 'ok' | 'full';
}

/** Round to two places the way the reference prints 87.33, without trailing noise. */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, '');
}

/**
 * The month rolls over on the first, in UTC, which is how the server buckets
 * charges (`monthStart` in the message-credit service). So the renewal date is
 * a fact, not a guess.
 */
export function renewalLabel(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = next.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `Renews ${month} 1`;
}

/**
 * The rows of the credit card, from what the server actually knows.
 *
 * The reference also prints a daily limit and an integration-credit meter.
 * Veltravia tracks neither, so neither is drawn. The month's meter needs a
 * ceiling to be a meter; without a monthly limit it shows what was spent and no
 * bar rather than inventing a denominator. Credits held for work in flight are
 * a row only while something is actually held.
 */
export function creditMeters(summary: MessageCreditSummary): readonly CreditMeter[] {
  const spent = summary.month.credits;
  const limit = summary.settings.monthlyLimit;
  const meters: CreditMeter[] = [];
  if (limit !== null && limit > 0) {
    const fraction = Math.min(1, Math.max(0, spent / limit));
    meters.push({
      label: 'Message credits',
      figure: `${formatCredits(spent)}/${formatCredits(limit)}`,
      fraction,
      tone: fraction >= 1 ? 'full' : 'ok',
    });
  } else {
    meters.push({
      label: 'Message credits',
      figure: `${formatCredits(spent)} used`,
      fraction: null,
      tone: 'ok',
    });
  }
  if (summary.wallet.reserved > 0) {
    meters.push({
      label: 'Held for work in progress',
      figure: formatCredits(summary.wallet.reserved),
      fraction: null,
      tone: 'ok',
    });
  }
  return meters;
}

export interface WorkspaceSheetProps {
  readonly open: boolean;
  readonly workspaceName: string;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  /** Injected for tests; the real call is the default. */
  readonly loadCredits?: () => Promise<MessageCreditSummary>;
}

const CHEVRONS = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="m8 9 4-4 4 4" />
    <path d="m8 15 4 4 4-4" />
  </svg>
);

const GEAR = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export function WorkspaceSheet({
  open,
  workspaceName,
  onClose,
  onOpenSettings,
  loadCredits = getMessageCreditSummary,
}: WorkspaceSheetProps) {
  const [credits, setCredits] = useState<CreditState>({ kind: 'loading' });
  const sheet = useRef<HTMLDivElement | null>(null);

  // Read the credits each time the sheet opens, so the card never shows a figure
  // from before the last message.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCredits({ kind: 'loading' });
    loadCredits().then(
      (summary) => {
        if (!cancelled) setCredits({ kind: 'ready', summary });
      },
      () => {
        if (!cancelled) setCredits({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, loadCredits]);

  useEffect(() => {
    if (!open) return;
    sheet.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={open ? 'v-sheet v-sheet--open' : 'v-sheet'}
      data-testid="workspace-sheet"
    >
      <div className="v-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheet}
        className="v-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${workspaceName}`}
        aria-hidden={!open}
        tabIndex={-1}
        inert={!open ? true : undefined}
      >
        <div className="v-sheet__handle" aria-hidden="true" />

        <div className="v-sheet__workspace">
          <span className="v-sheet__tile" aria-hidden="true">
            {workspaceInitials(workspaceName)}
          </span>
          <span className="v-sheet__who">
            <span className="v-sheet__name">{workspaceName}</span>
            <span className="v-sheet__plan">Free plan</span>
          </span>
          <span className="v-sheet__switch" aria-hidden="true">
            {CHEVRONS}
          </span>
        </div>

        <div className="v-sheet__body">
          <div className="v-sheet__credits" aria-busy={credits.kind === 'loading'}>
            {credits.kind === 'loading' ? (
              <div className="v-sheet__skeleton" role="status" aria-label="Loading credits">
                <span className="v-sheet__bone v-sheet__bone--title" />
                <span className="v-sheet__bone v-sheet__bone--line" />
                <span className="v-sheet__bone v-sheet__bone--thin" />
                <span className="v-sheet__bone v-sheet__bone--block" />
              </div>
            ) : credits.kind === 'error' ? (
              <p className="v-sheet__credits-error" role="alert">
                Credits could not be loaded. Close this and open it again to retry.
              </p>
            ) : (
              <>
                <div className="v-sheet__credits-head">
                  <span className="v-sheet__credits-title">Credits</span>
                  <span className="v-sheet__credits-renew">{renewalLabel(new Date())}</span>
                </div>
                <ul className="v-sheet__meters">
                  {creditMeters(credits.summary).map((meter) => (
                    <li key={meter.label} className="v-sheet__meter">
                      <div className="v-sheet__meter-row">
                        <span className="v-sheet__meter-label">{meter.label}</span>
                        {meter.fraction === null ? (
                          <span className="v-sheet__figure">{meter.figure}</span>
                        ) : null}
                      </div>
                      {meter.fraction !== null ? (
                        <div className="v-sheet__meter-row v-sheet__meter-row--bar">
                          <span
                            className="v-sheet__track"
                            role="progressbar"
                            aria-label={meter.label}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(meter.fraction * 100)}
                          >
                            <span
                              className={
                                meter.tone === 'full'
                                  ? 'v-sheet__fill v-sheet__fill--full'
                                  : 'v-sheet__fill'
                              }
                              style={{ inlineSize: `${meter.fraction * 100}%` }}
                            />
                          </span>
                          <span className="v-sheet__figure">{meter.figure}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="v-sheet__section">Workspace</div>
          <button
            type="button"
            className="v-sheet__item"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            <span className="v-sheet__item-icon">{GEAR}</span>
            <span>Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}

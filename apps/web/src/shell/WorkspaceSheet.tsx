import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getMessageCreditSummary, type MessageCreditSummary } from '../api/message-credits';
import { Button, Dialog } from '../components/ui';
import { useAgentProfile } from '../agent/AgentProfileProvider';
import { useTheme, type ThemePreference } from '../theme/ThemeProvider';
import { HelpDialog } from './HelpDialog';
import { ProfileDialog } from './ProfileDialog';
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
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m8 9 4-4 4 4" />
    <path d="m8 15 4 4 4-4" />
  </svg>
);

const CHEVRON_RIGHT = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const PERSON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
  </svg>
);

const SLIDERS = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);

const LANGUAGE = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
  </svg>
);

const QUESTION = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.6v.3" />
    <path d="M12 17h.01" />
  </svg>
);

const GIFT = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 11h16v9H4z" />
    <path d="M2.5 7.5h19V11h-19zM12 7.5V20" />
    <path d="M12 7.5S10.8 3.5 8.5 3.5a2 2 0 0 0 0 4M12 7.5s1.2-4 3.5-4a2 2 0 0 1 0 4" />
  </svg>
);

const PEOPLE = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="9.5" cy="8.5" r="3" />
    <path d="M3.5 19c0-2.8 2.7-5 6-5s6 2.2 6 5" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.4c2 .7 3.5 2.4 3.5 4.6" />
  </svg>
);

const MEGAPHONE = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 10v4a1 1 0 0 0 1 1h3l9 4V5L8 9H5a1 1 0 0 0-1 1Z" />
    <path d="M7 15v4a1 1 0 0 0 2 0v-3" />
  </svg>
);

const EXIT = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
    <path d="M10 8 6 12l4 4M6 12h9" />
  </svg>
);

const PALETTE = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.4-.7-.4-1.1 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" />
    <circle cx="8" cy="10" r="1" />
    <circle cx="12" cy="7.5" r="1" />
    <circle cx="15.8" cy="10" r="1" />
  </svg>
);

const GEAR = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

/**
 * Rows the reference has and Veltravia does not yet.
 *
 * He asked for them drawn anyway, so they are drawn the reference's way and
 * labelled "Soon", and tapping one says in one sentence what is missing. The row
 * never pretends to have done something: there is no fake sign-out, no invented
 * referral link, and no team invitation posted anywhere.
 */
export interface SoonRow {
  readonly id: 'earn' | 'members' | 'affiliate' | 'logout';
  readonly label: string;
  readonly body: string;
}

export const SOON_ROWS: readonly SoonRow[] = [
  {
    id: 'earn',
    label: 'Earn free credits',
    body: 'There is no rewards or referral programme yet, so there is nothing to earn. Your monthly credits reset on the 1st.',
  },
  {
    id: 'members',
    label: 'Add members',
    body: 'A workspace belongs to one person for now. Inviting other people needs shared projects, permissions and billing, and none of that is built.',
  },
  {
    id: 'affiliate',
    label: 'Become an affiliate',
    body: 'There is no affiliate programme yet. When there is one, this row will lead to it.',
  },
  {
    id: 'logout',
    label: 'Log out',
    body: 'Veltravia has no accounts or sessions yet, so there is nothing to sign out of. Your work stays with this browser until sign-in exists.',
  },
];

const APPEARANCES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function WorkspaceSheet({
  open,
  workspaceName,
  onClose,
  onOpenSettings,
  loadCredits = getMessageCreditSummary,
}: WorkspaceSheetProps) {
  const [credits, setCredits] = useState<CreditState>({ kind: 'loading' });
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [soon, setSoon] = useState<SoonRow | null>(null);
  // A child dialog is its own modal. While one is open the sheet stops being one,
  // so a screen reader is never offered two modals at once.
  const childOpen = profileOpen || helpOpen || soon !== null;
  const { preference, setPreference } = useTheme();
  const { ownerName } = useAgentProfile();
  const who = ownerName?.trim() ? ownerName.trim() : 'Add your name';

  const soonRow = (id: SoonRow['id'], icon: ReactNode) => {
    const row = SOON_ROWS.find((candidate) => candidate.id === id);
    if (row === undefined) return null;
    return (
      <button
        type="button"
        className="v-sheet__item v-sheet__item--soon"
        onClick={() => setSoon(row)}
        aria-label={`${row.label}, not available yet`}
      >
        <span className="v-sheet__item-icon">{icon}</span>
        <span className="v-sheet__item-label">{row.label}</span>
        <span className="v-sheet__soon">Soon</span>
      </button>
    );
  };
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
    <div className={open ? 'v-sheet v-sheet--open' : 'v-sheet'} data-testid="workspace-sheet">
      <div className="v-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheet}
        className="v-sheet__panel"
        role="dialog"
        aria-modal={childOpen ? undefined : 'true'}
        aria-label={`${workspaceName}`}
        aria-hidden={!open || childOpen}
        tabIndex={-1}
        inert={!open || childOpen ? true : undefined}
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
          {soonRow('earn', GIFT)}
          {soonRow('members', PEOPLE)}
          <button
            type="button"
            className="v-sheet__item"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            <span className="v-sheet__item-icon">{GEAR}</span>
            <span className="v-sheet__item-label">Settings</span>
          </button>

          <div className="v-sheet__rule" />

          {/* The reference puts the signed-in email here. Veltravia has no
              accounts yet, so this is the name its workspace is built on. */}
          <p className="v-sheet__identity">{who}</p>

          <button type="button" className="v-sheet__item" onClick={() => setProfileOpen(true)}>
            <span className="v-sheet__item-icon">{PERSON}</span>
            <span className="v-sheet__item-label">View profile</span>
            <span className="v-sheet__chevron">{CHEVRON_RIGHT}</span>
          </button>

          <button
            type="button"
            className="v-sheet__item"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            <span className="v-sheet__item-icon">{SLIDERS}</span>
            <span className="v-sheet__item-label">Account preferences</span>
            <span className="v-sheet__chevron">{CHEVRON_RIGHT}</span>
          </button>

          {soonRow('affiliate', MEGAPHONE)}

          {/* English only: the app ships one language, so this is a fact, not a
              control that would open an empty picker. */}
          <div className="v-sheet__item v-sheet__item--static">
            <span className="v-sheet__item-icon">{LANGUAGE}</span>
            <span className="v-sheet__item-label">Language</span>
            <span className="v-sheet__value">English</span>
          </div>

          {/* Appearance is a real preference: the provider writes data-theme on
              the root and follows the system when asked. */}
          <div className="v-sheet__item v-sheet__item--static">
            <span className="v-sheet__item-icon">{PALETTE}</span>
            <span className="v-sheet__item-label">Appearance</span>
            <span className="v-sheet__segmented" role="group" aria-label="Appearance">
              {APPEARANCES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    preference === option.value
                      ? 'v-sheet__segment v-sheet__segment--on'
                      : 'v-sheet__segment'
                  }
                  aria-pressed={preference === option.value}
                  onClick={() => setPreference(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>

          <button type="button" className="v-sheet__item" onClick={() => setHelpOpen(true)}>
            <span className="v-sheet__item-icon">{QUESTION}</span>
            <span className="v-sheet__item-label">Help &amp; support</span>
            <span className="v-sheet__chevron">{CHEVRON_RIGHT}</span>
          </button>

          {soonRow('logout', EXIT)}
        </div>
      </div>
      <ProfileDialog open={open && profileOpen} onClose={() => setProfileOpen(false)} />
      <HelpDialog open={open && helpOpen} onClose={() => setHelpOpen(false)} />
      <Dialog
        open={soon !== null}
        onClose={() => setSoon(null)}
        title={soon?.label ?? ''}
        footer={<Button onClick={() => setSoon(null)}>Close</Button>}
      >
        <p className="v-sheet__soon-body">{soon?.body}</p>
      </Dialog>
    </div>
  );
}

import { apiRequest } from './client';

/**
 * Typed client for the credit wallet (Step 53).
 *
 * Read-only by design: this dashboard shows what a wallet holds and what it has
 * been charged for. Adding credit, refunding and adjusting are operator actions
 * and are not reachable from here, which is the point - an ordinary user cannot
 * give themselves credits, and the UI should not look as though they could.
 */

export type WalletEntryKind =
  | 'purchase'
  | 'grant'
  | 'promotion'
  | 'usage_deduction'
  | 'reservation'
  | 'reservation_commit'
  | 'reservation_release'
  | 'refund'
  | 'adjustment_credit'
  | 'adjustment_debit'
  | 'reversal';

export type WalletScope = 'user' | 'workspace';

export interface WalletView {
  readonly id: string;
  readonly scope: WalletScope;
  readonly workspaceId: string | null;
  readonly unit: 'credits';
  readonly available: number;
  readonly reserved: number;
  readonly spent: number;
  readonly spendable: number;
  readonly currency: string;
  readonly policy: { readonly allowNegative: boolean; readonly negativeFloor: number };
  readonly updatedAt: string;
}

export interface WalletEntryView {
  readonly id: string;
  readonly seq: number;
  readonly kind: WalletEntryKind;
  readonly amount: number;
  readonly availableDelta: number;
  readonly reservedDelta: number;
  readonly spentDelta: number;
  readonly balanceAfter: number;
  readonly reason: string;
  readonly actor: string;
  readonly occurredAt: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
}

export interface WalletReservationView {
  readonly id: string;
  readonly amount: number;
  readonly state: 'held' | 'committed' | 'released' | 'expired';
  readonly operationKey: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface WalletOverviewView {
  readonly durable: boolean;
  readonly wallet: WalletView;
  readonly held: readonly WalletReservationView[];
  readonly recent: readonly WalletEntryView[];
  readonly rates: {
    readonly version: string;
    readonly rates: readonly string[];
    readonly note: string;
  };
  readonly note: string;
}

export interface WalletCapabilities {
  readonly durable: boolean;
  readonly currency: string;
  readonly unit: 'credits';
  readonly rateVersion: string;
  readonly rates: readonly string[];
  readonly rules: readonly string[];
  readonly limits: readonly string[];
}

export interface WalletReconciliation {
  readonly walletId: string;
  readonly consistent: boolean;
  readonly entries: number;
  readonly ledger: { available: number; reserved: number; spent: number };
  readonly stored: { available: number; reserved: number; spent: number };
  readonly problems: readonly string[];
}

function scopeQuery(workspaceId?: string | null): string {
  return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
}

export const getWalletOverview = (workspaceId?: string | null) =>
  apiRequest<WalletOverviewView>(`/api/wallet${scopeQuery(workspaceId)}`);

export const listWalletTransactions = (
  options: {
    readonly workspaceId?: string | null;
    readonly limit?: number;
    readonly kinds?: readonly WalletEntryKind[];
  } = {},
) => {
  const params = new URLSearchParams();
  if (options.workspaceId) params.set('workspaceId', options.workspaceId);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.kinds && options.kinds.length > 0) params.set('kind', options.kinds.join(','));
  const query = params.toString();
  return apiRequest<{ transactions: WalletEntryView[]; nextBefore: number | null }>(
    `/api/wallet/transactions${query ? `?${query}` : ''}`,
  );
};

export const getWalletCapabilities = () =>
  apiRequest<WalletCapabilities>('/api/wallet/capabilities');

export const reconcileWallet = (workspaceId?: string | null) =>
  apiRequest<WalletReconciliation>(`/api/wallet/reconcile${scopeQuery(workspaceId)}`);

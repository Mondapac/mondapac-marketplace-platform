// The admin customer page (customers management phase 1, B3): its tabs, the keys each section
// needs, and the answers it reads. Every section reads from its owning module by account id.

import type { CustomerRow } from './list-types.ts';

export const ORDERS_VIEW = 'ordering.order.view';
export const WALLET_VIEW = 'wallet.credit.view';
export const WALLET_ISSUE = 'wallet.credit.issue';
export const PROMOTIONS_VIEW = 'promotions.promotion.view';
export const BUYER_DELETE = 'customers.buyer-account.delete';
/** Edit and cancel a customer's sign-in email change (protected: behind a two-step code). */
export const EMAIL_CHANGE = 'customers.customer-email.change';

export const TABS = ['overview', 'orders', 'money'] as const;
export type Tab = (typeof TABS)[number];

export const isTab = (value: unknown): value is Tab =>
  typeof value === 'string' && (TABS as readonly string[]).includes(value);

/**
 * The tabs this admin sees: a tab whose every section needs a key they lack is left out. Money
 * always has its Spent and Refunded figures (they come with the page); its sections need keys.
 */
export const tabsFor = (keys: ReadonlySet<string>): readonly Tab[] =>
  TABS.filter((tab) => tab !== 'orders' || keys.has(ORDERS_VIEW));

/** GET customers/admin/customers/:accountId: the header and the Overview. */
export interface CustomerOverview extends CustomerRow {
  readonly firstOrderAt: string | null;
  /** Minor units of `currency`, as digits. */
  readonly refundedMinor: string;
  /** The open deletion request, or null (absent from an older API: none known). */
  readonly deletionRequest?: {
    readonly requestId: string;
    readonly status: 'pending' | 'executing';
    readonly requestedAt: string;
    readonly scheduledFor: string;
  } | null;
  /** The sign-in email an admin asked for that the customer has not confirmed, or null. */
  readonly pendingEmailChange?: { readonly email: string; readonly requestedAt: string } | null;
}

/** The average of the confirmed orders, in minor units (rounded down), or null with none. */
export function averageMinor(spentMinor: string, orders: number): string | null {
  if (orders <= 0 || !/^\d+$/.test(spentMinor)) return null;
  return (BigInt(spentMinor) / BigInt(orders)).toString();
}

/** GET wallet/admin/customers/:id/history: the journal, newest first. */
export interface WalletHistory {
  readonly currency: string;
  readonly entries: readonly {
    readonly journalId: string;
    readonly kind: string;
    /** Signed minor units: a credit is positive, a spend negative. */
    readonly amount: string;
    readonly reasonCode: string | null;
    readonly orderId: string | null;
    readonly createdAt: string;
  }[];
  readonly nextCursor: string | null;
}

/** GET ordering/admin/customers/:accountId/refunds (newest 100). */
export interface CustomerRefunds {
  readonly refunds: readonly {
    readonly refundId: string;
    readonly orderId: string;
    readonly sellerOrderId: string;
    readonly state: string;
    readonly reason: string;
    readonly amount: { readonly amount: string; readonly currency: string };
    readonly requestedAt: string;
    readonly settledAt: string | null;
    readonly creditNoteId: string | null;
  }[];
}
export const REFUNDS_CAP = 100;

/** GET promotions/admin/customers/:id/credits. */
export interface PromotionCredits {
  readonly items: readonly {
    readonly id: string;
    readonly promotionId: string;
    readonly kind: string;
    readonly orderId: string | null;
    readonly amountMinor: string;
    readonly currency: string;
    readonly status: string;
    readonly createdAt: string;
    readonly settledAt: string | null;
  }[];
  readonly nextCursor: string | null;
}

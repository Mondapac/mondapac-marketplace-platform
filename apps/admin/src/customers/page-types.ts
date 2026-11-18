// The admin customer page (customers management phase 1, B3): its tabs, the keys each section
// needs, and the answers it reads. Every section reads from its owning module by account id.

import type { CustomerRow } from './list-types.ts';
import { BEHAVIOUR_VIEW, CONSENT_VIEW, SIGN_IN_VIEW, VIEW_KEY } from './security-types.ts';

export { BEHAVIOUR_VIEW };

export const ORDERS_VIEW = 'ordering.order.view';
export const WALLET_VIEW = 'wallet.credit.view';
export const WALLET_ISSUE = 'wallet.credit.issue';
export const PROMOTIONS_VIEW = 'promotions.promotion.view';
export const BUYER_DELETE = 'customers.buyer-account.delete';

// Phase 2b, part C (Shopping and Reviews tabs): each section is under its owner's key.
export const CART_VIEW = 'cart.customer-cart.view';
export const REMINDER_VIEW = 'notifications.customer-cart-reminder.view';
export const ASSISTANT_VIEW = 'assistant.customer-conversation.view';
export const REVIEWS_VIEW = 'reviews.customer-review.view';
/** The tabs of part C and the keys of their sections: a tab shows when the admin holds one. */
export const SHOPPING_KEYS = [CART_VIEW, REMINDER_VIEW, BEHAVIOUR_VIEW, ASSISTANT_VIEW] as const;

export const TABS = [
  'overview',
  'orders',
  'money',
  'shopping',
  'reviews',
  'security',
] as const;
export type Tab = (typeof TABS)[number];

export const isTab = (value: unknown): value is Tab =>
  typeof value === 'string' && (TABS as readonly string[]).includes(value);

/**
 * The tabs this admin sees: a tab whose every section needs a key they lack is left out. Money
 * always has its Spent and Refunded figures (they come with the page); its sections need keys.
 */
export const tabsFor = (keys: ReadonlySet<string>): readonly Tab[] =>
  TABS.filter(
    (tab) =>
      (tab !== 'orders' || keys.has(ORDERS_VIEW)) &&
      (tab !== 'shopping' || SHOPPING_KEYS.some((key) => keys.has(key))) &&
      (tab !== 'reviews' || keys.has(REVIEWS_VIEW)) &&
      // Account & security (part B): addresses need only the page's own key, so it is nearly
      // always there; the other sections add theirs.
      (tab !== 'security' ||
        [VIEW_KEY, SIGN_IN_VIEW, CONSENT_VIEW, BEHAVIOUR_VIEW].some((key) => keys.has(key))),
  );

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

/** GET customers/admin/customers/:id/cart (cart): ids, never names; money is minor units as digits. */
export interface CartAnswer {
  readonly savedCount: number;
  readonly cart: {
    readonly createdAt: string;
    readonly lastChangedAt: string;
    readonly lines: readonly {
      readonly offerId: string;
      readonly variantId: string;
      readonly quantity: number;
      readonly priceAtAdd: { readonly amount: string; readonly currency: string };
      readonly addedAt: string;
    }[];
  } | null;
}

/** GET customers/admin/customers/:id/behaviour (engagement): counts and ids, never search text. */
export interface BehaviourAnswer {
  readonly personalization: { readonly enabled: boolean; readonly changedAt: string | null };
  readonly summary: {
    readonly productViews: number;
    readonly categoryViews: number;
    readonly cartAdditions: number;
    readonly topCategories: readonly { readonly categoryId: string; readonly views: number }[];
  };
}

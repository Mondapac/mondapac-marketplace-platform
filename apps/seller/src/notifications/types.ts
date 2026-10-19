// Answers of the seller notice routes (apps/api seller-notices.controller.ts).

/** The only seller kind today: a paid seller order (in-app notifications package 1). */
export const ORDER_PAID = 'seller.order-paid';

/** The kinds that play the new-order sound (plan 6b): orders only. */
export const RINGING_KINDS: ReadonlySet<string> = new Set([ORDER_PAID]);

/** The permission that shows order notices; the bell is shown only to members who hold it. */
export const NOTICES_PERMISSION = 'ordering.seller-order.view';

export interface Notice {
  readonly id: string;
  readonly kind: string;
  /** seller.order-paid: the seller order and its number of items. No customer data. */
  readonly params: { readonly sellerOrderId?: string; readonly items?: number };
  readonly createdAt: string;
  readonly read: boolean;
}

/** A notice of the list: seller.order-paid adds the customer's short name ("Maryam R."). */
export interface ListedNotice extends Notice {
  /** Null without identity.customer-short-name.view, or when the customer gave no name. */
  readonly customerShortName?: string | null;
}

export interface NoticePage {
  readonly items: readonly ListedNotice[];
  readonly next: string | null;
}

export interface UnreadNotices {
  readonly unread: number;
  readonly newest: Notice | null;
}

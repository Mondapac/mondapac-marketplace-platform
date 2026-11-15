import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { OrderCustomerView } from './order-views';
import type { RefundReason } from './refund';

// The admin Invoices list (panel menu v2, Sales > Invoices; a super list, CLAUDE.md rule 14).
// Owner decision 2026-11-15 (12:58Z): until numbered tax invoices exist (gap-free numbering waits
// for the tax adviser, AG-11), the page lists the documents the platform already issues: the
// order confirmation of each paid seller order, and the credit note of each succeeded refund.
// Neither is called a tax invoice and neither has a number (`documentNumber` stays null); the
// rows become numbered invoices and adjustment notes once numbering is built. Read only.

/** The two kinds of document, one tab each. */
export const DOCUMENT_KINDS = ['order-confirmation', 'credit-note'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_ROW_ACTIONS = ['view-order', 'download-order-document'] as const;
export type DocumentRowAction = (typeof DOCUMENT_ROW_ACTIONS)[number];

export const DOCUMENT_SORT_KEYS = ['issued', 'amount'] as const;
export type DocumentSortKey = (typeof DOCUMENT_SORT_KEYS)[number];

/** Where a Previous/Next page starts: after this document, newest first. */
export interface DocumentCursor {
  readonly issuedAt: Temporal.Instant;
  readonly documentId: string;
}

export interface DocumentSort {
  readonly key: DocumentSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. `kind` is always set: one tab at a time. */
export interface DocumentListFilter {
  readonly kind: DocumentKind;
  /** An order, seller order, credit note or refund id, exact. */
  readonly reference: string | null;
  readonly sellerId: Id<'Seller'> | null;
  /** Issued at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** The document's total (tax included), minor units, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
  readonly parties: {
    readonly accountIds: readonly Id<'Account'>[];
    readonly sellerIds: readonly Id<'Seller'>[];
  } | null;
}

export interface DocumentListRecord {
  readonly kind: DocumentKind;
  /** The seller order id for a confirmation; the credit note id for a credit note. */
  readonly documentId: string;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
  /** When the payment was confirmed, or when the refund succeeded. */
  readonly issuedAt: Temporal.Instant;
  /** The seller order's total, or what the credit note gives back; tax included. */
  readonly total: Money;
  /** The tax inside `total`; null when a line was placed before its tax was recorded. */
  readonly tax: Money | null;
  /**
   * The delivery fee as the buyer paid it on a confirmation, and the shipping given back on a
   * credit note; both tax included (the fee plus its tax where the price excluded it).
   */
  readonly shipping: Money;
  /** Credit notes only: the refund and its reason. */
  readonly refundId: Id<'Refund'> | null;
  readonly refundReason: RefundReason | null;
}

export interface DocumentKindCounts {
  readonly orderConfirmations: number;
  readonly creditNotes: number;
}

export interface DocumentListRow extends DocumentListRecord {
  /** Always null until gap-free numbering exists (AG-11). */
  readonly documentNumber: null;
  readonly storeName: string | null;
  /** PERSONAL DATA; null without the customer key or when the lookup failed. */
  readonly customer: OrderCustomerView | null;
  readonly actions: readonly DocumentRowAction[];
}

export interface DocumentListPage {
  readonly rows: readonly DocumentListRow[];
  readonly counts: DocumentKindCounts;
  /**
   * Page numbers (List paging `pages`): the total, the page and its size. Previous/Next
   * (`prev-next`, or past row 10,000): total and page are null and `nextCursor` leads on.
   */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

/**
 * The row actions of one document: open the order (same view key as the list); a confirmation
 * also downloads the order document admins already get on the order page. A credit note has no
 * document of its own yet.
 */
export function documentRowActions(record: DocumentListRecord): readonly DocumentRowAction[] {
  return record.kind === 'order-confirmation'
    ? ['view-order', 'download-order-document']
    : ['view-order'];
}

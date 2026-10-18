import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// In-app notices (in-app notifications package 1). A notice says what happened, as a kind and a
// few ids or counts; the panel renders the text in its own language and builds the link to the
// item from the same fields. Nothing personal is kept: no name, no address, no email.

/** A notice stays this many days; older ones are neither shown nor kept. */
export const NOTICE_RETENTION_DAYS = 90;
/** At most this many notices per seller; the oldest beyond it are deleted. */
export const NOTICES_PER_SELLER = 200;
/** One page of the list. */
export const NOTICE_PAGE_SIZE = 20;

/** A new paid seller order: the seller order id (the link) and the number of items in it. */
export const SELLER_ORDER_PAID = 'seller.order-paid';

export interface SellerOrderPaidParams {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly items: number;
}

/** Every kind a seller may see, with what its params hold. */
export type SellerNoticeKind = typeof SELLER_ORDER_PAID;
export const SELLER_NOTICE_KINDS: readonly SellerNoticeKind[] = [SELLER_ORDER_PAID];

export type NoticeParams = SellerOrderPaidParams;

/**
 * Reads stored params back for one kind, keeping only the known fields. `null` when a row does
 * not have the shape its kind promises; such a row is left out rather than shown half-built.
 */
export function parseNoticeParams(kind: string, raw: unknown): NoticeParams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (kind === SELLER_ORDER_PAID) {
    if (typeof value.sellerOrderId !== 'string') return null;
    const sellerOrderId = parseId(value.sellerOrderId);
    const items = value.items;
    if (!sellerOrderId.ok) return null;
    if (typeof items !== 'number' || !Number.isSafeInteger(items) || items < 0) return null;
    return { sellerOrderId: sellerOrderId.value as Id<'SellerOrder'>, items };
  }
  return null;
}

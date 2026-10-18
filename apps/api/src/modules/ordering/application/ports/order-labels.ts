import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { OrderCustomerView } from '../../domain/order-views';

// Display-only lookups for the panel order pages (frontend batch 3 gaps). Every lookup is
// advisory: a failure or an absent key never fails the read; the field shows null.

/** One (Offer, Variant) of an order line. */
export interface OrderUnitKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The published product name and Variant label of an order line (seller text; escape it). */
export interface OrderUnitLabel {
  readonly productName: string;
  readonly variantLabel: string | null;
}

/** Who placed an order, for an admin entitled to see it. PERSONAL DATA: never logged. */
export type OrderCustomer = OrderCustomerView;

/** The map key of one (Offer, Variant) in the answer of {@link OrderLabels.unitLabelsOf}. */
export function orderUnitKey(key: OrderUnitKey): string {
  return `${key.offerId}:${key.variantId}`;
}

/**
 * The names an order page shows, read through the owning modules' facades with the caller's
 * `CallContext` unchanged. Each method throws when the owner refuses or fails; an unknown key and
 * another Market's key are absent.
 */
export interface OrderLabels {
  /** catalog's `sellUnitLabels`: published content only. */
  unitLabelsOf(
    context: CallContext,
    keys: readonly OrderUnitKey[],
  ): Promise<ReadonlyMap<string, OrderUnitLabel>>;
  /** sellers' `sellerSummaries`: the public store name of the approved revision only. */
  storeNamesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;
  /**
   * identity's `customerAccountSummaries` (`identity.customer-account.view`). An admin without
   * the key gets an empty map, not an error: the page shows no customer.
   */
  customersOf(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, OrderCustomer>>;
  /**
   * identity's `customerShortNames` (`identity.customer-short-name.view`), for a seller's own
   * order notices. A seller member without the key gets an empty map, not an error.
   */
  customerShortNamesOf(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, string>>;
}

export const ORDER_LABELS = Symbol('ORDER_LABELS');

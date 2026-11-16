import type { CallContext, Id } from '@mondapac/shared-kernel';

export const SELLER_NAMES = Symbol('PAYMENTS_SELLER_NAMES');

/**
 * What the admin Seller accounts list asks of sellers (its facade): the public store names of the
 * rows, and the sellers whose name matches the search box. Never anything of a payout account goes
 * the other way.
 */
export interface SellerNames {
  /** `unavailable` when the read failed: the list then shows the seller id instead of a name. */
  storeNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<string, string | null> | 'unavailable'>;
  /**
   * The sellers whose approved public store name contains `term`. Throws when the read failed;
   * the list then refuses the search instead of showing every account. The term is never logged.
   */
  storesMatching(
    context: CallContext,
    term: string,
  ): Promise<{ readonly sellerIds: readonly string[]; readonly capped: boolean }>;
}

import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The commission rate in force for a seller now, in basis points: the seller's own rate if an
 * admin set one, else the Market's. Null when it cannot be read; a preview then fails closed
 * (it shows no money rather than a guessed one). Bound to `commission-payouts`'
 * `commissionRates`, called with the seller's own context (that read is for own resources only).
 * Called before any unit opens.
 */
export interface SellerCommission {
  rateBps(context: CallContext, sellerId: Id<'Seller'>): Promise<number | null>;
}

export const SELLER_COMMISSION = Symbol('PROMOTIONS_SELLER_COMMISSION');

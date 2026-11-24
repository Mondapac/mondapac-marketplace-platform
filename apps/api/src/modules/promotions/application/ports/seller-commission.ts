import type { CallContext, Id } from '@mondapac/shared-kernel';

/** What the commission would be on an amount, as the ledger will work it out. */
export interface OwnCommission {
  readonly rateBps: number;
  /** The amount the rate is applied to (less the line's tax when the amount includes tax). */
  readonly commissionBase: bigint;
  readonly commission: bigint;
  /** `amount − commission`: what the ledger credits the seller (tax it owes included). */
  readonly sellerReceives: bigint;
}

/** The tax rate of a line, read on the server. */
export interface LineTaxRate {
  readonly rateBps: number;
  /**
   * True when no Offer was named: the rate is the strategy's rate for a line in no category, an
   * estimate. False when it is the Offer's own category rate, the one checkout freezes.
   */
  readonly estimated: boolean;
}

/**
 * The commission the signed-in seller would pay on an amount: its own rate (or the Market's), the
 * ledger's base and rounding, on the line's own tax rate. Null when it cannot be read; a preview
 * then fails closed (it shows no money rather than a guessed one). Bound to `commission-payouts`'
 * `ownCommissionOn`, called with the seller's own context: that read takes no seller id, so nobody
 * else's rate can be asked. The tax rate comes from `lineTaxRate`, never from a request body.
 * Called before any unit opens.
 */
export interface SellerCommission {
  /**
   * The tax rate of a line of `offerId` (its product's published tax category under the strategy
   * in force), or of a line in no category when `offerId` is null. The caller has already checked
   * that the Offer is the seller's own. Null when anything cannot be read (an Offer without a
   * published category, an unknown category, a tax refusal): fail closed.
   */
  lineTaxRate(context: CallContext, offerId: Id<'Offer'> | null): Promise<LineTaxRate | null>;

  commissionOn(
    context: CallContext,
    amount: bigint,
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<OwnCommission | null>;
}

export const SELLER_COMMISSION = Symbol('PROMOTIONS_SELLER_COMMISSION');

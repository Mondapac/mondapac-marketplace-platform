import type { CallContext, Id } from '@mondapac/shared-kernel';

/** The commission on one amount, the way the ledger will work it out for the signed-in seller. */
export interface OwnLineCommission {
  /** `commissionBase × rate`, rounded the way the ledger rounds. */
  readonly commission: bigint;
  /** `amount − commission`: what the ledger credits the seller (tax it owes included). */
  readonly sellerReceives: bigint;
}

/**
 * What pricing reads to estimate what the signed-in seller receives for a sale of one of its own
 * Offers (Offer page PR 4, "You receive (est.)"): the line's tax rate (the Offer's published tax
 * category under the tax strategy in force) and the seller's own commission on an amount, from
 * `commission-payouts`' `ownCommissionOn`. Both are called with the seller's context unchanged:
 * the seller comes from the session, so nobody else's rate can be asked. Called before any unit
 * opens. A refusal, a fault or a missing value is null: the estimate then shows no money rather
 * than a guessed one (fail closed).
 */
export interface OwnCommissionSource {
  /**
   * The tax rate, in basis points, of a line of `offerId`. The caller has already checked that
   * the Offer is the seller's own. Null when the Offer has no published tax category or anything
   * cannot be read.
   */
  lineTaxRate(context: CallContext, offerId: Id<'Offer'>): Promise<number | null>;

  /** The seller's own commission on `amount`; null when it cannot be read. */
  commissionOn(
    context: CallContext,
    amount: bigint,
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<OwnLineCommission | null>;
}

export const OWN_COMMISSION_SOURCE = Symbol('PRICING_OWN_COMMISSION_SOURCE');

import type { CallContext } from '@mondapac/shared-kernel';

/** What the commission would be on an amount, as the ledger will work it out. */
export interface OwnCommission {
  readonly rateBps: number;
  /** The amount the rate is applied to (less provisional tax when the amount includes tax). */
  readonly commissionBase: bigint;
  readonly commission: bigint;
}

/**
 * The commission the signed-in seller would pay on an amount: its own rate (or the Market's), the
 * ledger's base and rounding. Null when it cannot be read; a preview then fails closed (it shows
 * no money rather than a guessed one). Bound to `commission-payouts`' `ownCommissionOn`, called
 * with the seller's own context: that read takes no seller id, so nobody else's rate can be asked.
 * Called before any unit opens.
 */
export interface SellerCommission {
  commissionOn(
    context: CallContext,
    amount: bigint,
    taxInclusive: boolean,
  ): Promise<OwnCommission | null>;
}

export const SELLER_COMMISSION = Symbol('PROMOTIONS_SELLER_COMMISSION');

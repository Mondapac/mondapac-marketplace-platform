// The order's discounts as ordering keeps them (promotions package T2). Promotions prices them;
// ordering freezes them on the lines and seller orders, charges the net amounts, gives the seller
// ledger the line net of the seller's share and refunds no more than the buyer paid.

const BPS = 10_000n;

/** One line's discount and who funds it (minor units). */
export interface LineDiscount {
  readonly amount: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
}

export const NO_DISCOUNT: LineDiscount = { amount: 0n, sellerShare: 0n, platformShare: 0n };

const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The commission of one line as the seller ledger will post it: the line after the seller's share
 * of its discount (the platform's share never lowers the seller's commission, owner Q2/Q3), less
 * the provisional tax when the price includes tax, times the rate, each rounded half up. The same
 * arithmetic as commission-payouts' ledger, so promotions caps the platform's share by it (Q6).
 */
export function lineCommission(
  line: {
    readonly lineAmount: bigint;
    readonly sellerShare: bigint;
    readonly taxInclusive: boolean;
    readonly rateBps: number;
  },
  provisionalTaxBps: number,
): bigint {
  const amount = line.lineAmount - line.sellerShare;
  const base =
    !line.taxInclusive || provisionalTaxBps === 0
      ? amount
      : roundHalfUp(amount * BPS, BPS + BigInt(provisionalTaxBps));
  return roundHalfUp(base * BigInt(line.rateBps), BPS);
}

/** What the seller is paid for a line before commission: the line less the seller's share. */
export const ledgerLineAmount = (line: {
  readonly lineAmount: bigint;
  readonly discountSellerShare: bigint;
}): bigint => line.lineAmount - line.discountSellerShare;

/**
 * The goods the buyer paid for `units` of a line, after `before` units already refunded: the
 * line's net amount (after its discount) spread over its units, floored, so the last unit takes
 * the rounding remainder and all units together give back exactly the net amount.
 */
export function netGoodsOf(
  line: { readonly lineAmount: bigint; readonly discountAmount: bigint; readonly quantity: number },
  before: number,
  units: number,
): bigint {
  const net = line.lineAmount - line.discountAmount;
  const quantity = BigInt(line.quantity);
  const upTo = (count: number) => (net * BigInt(count)) / quantity;
  return upTo(before + units) - upTo(before);
}

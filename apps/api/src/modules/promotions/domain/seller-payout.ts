import { floorShare } from './calculation/allocation';

// The money of one sale under the seller's own percentage sale (a seller-funded discount): the
// seller pays all of it. A co-funded campaign is worked out by the real calculation, never here;
// the commission comes from `commission-payouts` (its own rate, the ledger's base and rounding).
// Pure.

export interface OwnSaleSplit {
  readonly discount: bigint;
  readonly sellerFunded: bigint;
  readonly platformFunded: bigint;
  readonly shopperPays: bigint;
}

/** `price × bps`, floored, all paid by the seller. */
export function ownSaleSplit(price: bigint, bps: number): OwnSaleSplit {
  if (price < 1n) throw new RangeError('price must be at least 1');
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new RangeError('bps');
  const discount = floorShare(price, bps);
  return { discount, sellerFunded: discount, platformFunded: 0n, shopperPays: price - discount };
}

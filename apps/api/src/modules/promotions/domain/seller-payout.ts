import { floorShare } from './calculation/allocation';
import type { Reward } from './calculation/types';

// What a seller gets from one sale at a price while a discount runs (plan decisions 2 and 3):
// the commission is taken on the price after the part of the discount the seller funds; the part
// the platform funds never lowers the seller's share. Pure; the rate comes from
// `commission-payouts`. The rounding of the commission is the ledger's (half up), so the preview
// shows the number the ledger will post. Shipping and GST are outside the preview.

const BPS = 10_000n;

export interface SellerPayoutInput {
  /** The price of one unit before the discount, in minor units. */
  readonly price: bigint;
  /** The discount; null for no discount (the price as it stands). */
  readonly reward: Reward | null;
  /** The platform's share of the discount, in basis points (0 for a seller-funded one). */
  readonly platformShareBps: number;
  /** The seller's commission rate, in basis points. */
  readonly commissionRateBps: number;
}

export interface SellerPayoutPreview {
  readonly price: bigint;
  readonly discount: bigint;
  readonly sellerFunded: bigint;
  readonly platformFunded: bigint;
  readonly shopperPays: bigint;
  readonly commissionBase: bigint;
  readonly commission: bigint;
  readonly sellerGets: bigint;
}

const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

export function sellerPayoutPreview(input: SellerPayoutInput): SellerPayoutPreview {
  const { price, reward } = input;
  if (price < 1n) throw new RangeError('price must be at least 1');
  if (!Number.isInteger(input.platformShareBps) || input.platformShareBps < 0) {
    throw new RangeError('platformShareBps');
  }
  if (input.platformShareBps > 10_000) throw new RangeError('platformShareBps');
  if (
    !Number.isInteger(input.commissionRateBps) ||
    input.commissionRateBps < 0 ||
    input.commissionRateBps > 10_000
  ) {
    throw new RangeError('commissionRateBps');
  }
  let discount = 0n;
  if (reward !== null) {
    discount = reward.kind === 'PERCENT' ? floorShare(price, reward.bps) : reward.amount;
    if (discount > price) discount = price;
    if (discount < 0n) discount = 0n;
  }
  const platformFunded = floorShare(discount, input.platformShareBps);
  const sellerFunded = discount - platformFunded;
  const commissionBase = price - sellerFunded;
  const commission = roundHalfUp(commissionBase * BigInt(input.commissionRateBps), BPS);
  return {
    price,
    discount,
    sellerFunded,
    platformFunded,
    shopperPays: price - discount,
    commissionBase,
    commission,
    sellerGets: commissionBase - commission,
  };
}

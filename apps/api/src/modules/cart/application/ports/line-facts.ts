import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import type { LineAvailability } from '../../domain/cart';
import type { SellerMinimum } from '../../domain/cart-evaluator';

export type UnavailableReason =
  'offer-unavailable' | 'seller-not-eligible' | 'no-valid-price' | 'out-of-stock';

/**
 * What the other modules say about one sell unit right now (cart design 3.2, 6.2). Composed at
 * read time, never stored. `check-unavailable`: a facade failed, so the line is not buyable
 * (fail closed) but the cart can still be shown.
 */
export interface LineVerdict {
  readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
  readonly reason: UnavailableReason | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly unitPrice: Money | null;
  readonly taxInclusive: boolean | null;
  readonly availability: LineAvailability | null;
}

export interface SellUnitRef {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The verdict key of a sell unit. */
export const verdictKey = (ref: SellUnitRef): string => `${ref.offerId}/${ref.variantId}`;

/**
 * Asks catalog, sellers, pricing and inventory about up to 200 sell units, in two rounds,
 * passing the caller's `CallContext` unchanged. Never throws for a facade failure; it answers
 * `check-unavailable` for the affected units. Called before any unit opens (no facade call
 * inside a unit).
 */
export interface LineFactsSource {
  evaluate(
    context: CallContext,
    refs: readonly SellUnitRef[],
  ): Promise<ReadonlyMap<string, LineVerdict>>;

  /**
   * The minimum order of each of the distinct sellers (cart design 6.4), from one
   * `sellers.sellerSummaries` batch per 100 ids. `none` only when `sellers` answered an explicit
   * none; a seller whose key is absent from the answer, or a failed call, is `unknown` (fail
   * closed). Never throws.
   */
  sellerMinimums(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerMinimum>>;

  /**
   * The flat delivery fee of each of the distinct sellers, from `shipping.flatFees` (one batch
   * per 100 ids). A seller without a fee, or a failed call, is absent: the cart shows no fee and
   * checkout refuses that seller. Never throws.
   */
  sellerDeliveryFees(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, Money>>;
}

export const LINE_FACTS_SOURCE = Symbol('LINE_FACTS_SOURCE');

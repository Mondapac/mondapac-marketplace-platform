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

/**
 * What the buyer sees of one sell unit beside its verdict (cart design 6.2: product name, Variant
 * label, primary image): the published revision's, in the Market's default locale. Display only,
 * never a reason to buy; seller-entered text, so the client escapes it.
 */
export interface LineDisplay {
  readonly productId: Id<'Product'>;
  readonly productName: string | null;
  readonly variantLabel: string | null;
  /** The first clean image of the published revision; the client builds the URL. */
  readonly imageId: Id | null;
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
   * The display data of each sell unit, from `catalog.offerListings` (one batch per 200 keys). A
   * unit catalog does not answer (unpublished, deleted, another Market) or a failed call is
   * absent: the line shows its state only. Never throws.
   */
  lineDisplays(
    context: CallContext,
    refs: readonly SellUnitRef[],
  ): Promise<ReadonlyMap<string, LineDisplay>>;

  /**
   * The public store name of each seller ("Sold by", CRT-03), from `sellers.sellerSummaries`. A
   * seller without an approved revision, or a failed call, is absent. Never throws.
   */
  sellerNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;
}

export const LINE_FACTS_SOURCE = Symbol('LINE_FACTS_SOURCE');

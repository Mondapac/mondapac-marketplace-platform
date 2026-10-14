import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** At most this many keys per batch call; a larger call is refused whole. */
export const MAX_PRICE_BATCH = 200;

/** One priced unit: an Offer and one of its Variants. */
export interface PriceKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The map key of a {@link PriceKey}. */
export function priceKeyOf(key: PriceKey): string {
  return `${key.offerId}/${key.variantId}`;
}

/**
 * The price a buyer pays right now: the special price in force when it is below the regular
 * price in force, else the regular price (pricing design 4.1). No Cost, no hold, no history: a
 * buyer-facing read (ADR-0024). It does not check that the Offer is visible: the caller (cart,
 * storefront) checks catalog's published state first and never passes buyer-supplied keys
 * unchecked. `taxInclusive` is the Market's `pricesIncludeTax` when the record was written.
 */
export interface EffectivePrice {
  readonly price: Money;
  readonly taxInclusive: boolean;
  /** The record the price comes from: a regular record, or a special record when `basis` is `special`. */
  readonly recordId: Id<'RegularPriceRecord'> | Id<'SpecialPriceRecord'>;
  readonly basis: 'regular' | 'special';
  /** When the special window ends; null unless `basis` is `special`. */
  readonly specialEndsAt: Temporal.Instant | null;
}

/** Per requested key that has a price in force. A key without one is absent ("no valid price"). */
export type EffectivePriceMap = ReadonlyMap<string, EffectivePrice>;

export interface PricingValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export interface PricingBatchTooLarge {
  readonly code: 'batch.too-large';
}

/**
 * The public facade of `pricing`. Takes the caller's `CallContext` unchanged. Advisory: the cart
 * re-reads at checkout. Not exposed over HTTP.
 */
export interface PricingFacade {
  /**
   * The effective price (special in force, else regular) for each key (at most 200 keys), keyed
   * by {@link priceKeyOf}.
   */
  effectivePrices(
    context: CallContext,
    keys: readonly PriceKey[],
  ): Promise<
    Result<EffectivePriceMap, AccessDenied | PricingValidationFailed | PricingBatchTooLarge>
  >;
}

/** Nest token of the {@link PricingFacade}, provided and exported by `PricingModule`. */
export const PRICING_FACADE = Symbol('PRICING_FACADE');

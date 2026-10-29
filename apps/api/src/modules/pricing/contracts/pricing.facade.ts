import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** At most this many keys per batch call; a larger call is refused whole. */
export const MAX_PRICE_BATCH = 200;

/** The longest window `daysAtPrice` measures, in days; a longer one is refused. */
export const MAX_PRICE_HISTORY_WINDOW_DAYS = 366;

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

  /**
   * How many whole days of the last `windowDays` days (ending now; at most
   * {@link MAX_PRICE_HISTORY_WINDOW_DAYS}) the effective price of one key was exactly `price`:
   * the fact behind promotions' was-price rule (AU: at least 28 of the last 90). The time at the
   * price is summed over the window and floored to whole 24-hour days. Only prices that were in
   * force count (accepted or approved regular records, specials in force below the regular): a
   * pending, rejected or never-effective record never does, and no Cost is read. A retired
   * series counts until its retirement. `null` when the key has no series in the context's
   * Market (another Market's key alike); the caller treats `null` as "not eligible". Two use
   * cases behind this method, as for `effectivePrices`. Not exposed over HTTP.
   */
  daysAtPrice(
    context: CallContext,
    key: PriceKey,
    price: Money,
    windowDays: number,
  ): Promise<Result<number | null, AccessDenied | PricingValidationFailed>>;
}

/** Nest token of the {@link PricingFacade}, provided and exported by `PricingModule`. */
export const PRICING_FACADE = Symbol('PRICING_FACADE');

import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CalculationOutput } from '../domain/calculation/types';

export interface QuoteLine {
  /** The caller's reference for the line; the allocation of every discount is keyed by it. */
  readonly id: string;
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly unitPrice: Money;
  readonly quantity: number;
}

export interface QuoteShipping {
  readonly id: string;
  readonly sellerId: Id<'Seller'> | null;
  /** The delivery zone of the shipping charge (shipping's zone code). */
  readonly zoneCode: string;
  readonly amount: Money;
}

export interface QuoteRequest {
  readonly lines: readonly QuoteLine[];
  readonly shipping: readonly QuoteShipping[];
  /** The one code the customer typed; null for none. */
  readonly code: string | null;
  readonly isFirstOrder: boolean;
  /**
   * The customer's account, for the discounts aimed at a customer segment or at the followers of a
   * store. Their facts (the last order, the stores they follow) are read on the server from the
   * modules that own them; a customer that is absent or whose facts cannot be read gets none of
   * those discounts (fail closed). A browser never states the facts.
   */
  readonly customerAccountId?: Id<'Account'> | null;
  /** A test order: test-mode promotions apply to it, and to nothing else. */
  readonly testMode: boolean;
  /** The commission of the order: the platform's share of its discounts is capped by it. */
  readonly orderCommission: Money;
}

/** The calculation, and whether promotions were on (off: no discount was looked for). */
export interface QuoteResult extends CalculationOutput {
  readonly enabled: boolean;
}

export type PromotionsFacadeFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** Promotions are off in this Market (the default until an admin switches them on). */
  | { readonly code: 'promotions.disabled' }
  /** The Market has no promotions settings or a read failed: callers fail closed. */
  | { readonly code: 'promotions.unavailable' };

/**
 * The public facade of `promotions`. Every method takes the caller's `CallContext` first,
 * unchanged, and is a thin call of one use case, so the gate runs. Other modules inject
 * {@link PROMOTIONS_FACADE}; they never read promotions' tables.
 */
export interface PromotionsFacade {
  /**
   * The discounts of one cart, calculated on the server from the prices and shipping the caller
   * supplies (rule `system`; never a browser's amounts). Layers in order: item, seller cart,
   * platform cart, shipping; wallet credit is payment and is not here. The answer carries the
   * allocation of every discount to its line with the seller and platform shares. With the Market
   * switch off the answer is the cart with no discount and `enabled: false`. In-process.
   */
  quote(
    context: CallContext,
    request: QuoteRequest,
  ): Promise<Result<QuoteResult, PromotionsFacadeFailure>>;

  /**
   * Whether a priced unit (an Offer's Variant) may show a struck-through earlier price: it sold at
   * `price` on at least the Market's minimum number of days in the Market's window (AU 28 of the
   * last 90), as `pricing` measures it. Rule `anonymous`. Unknown history is `false`.
   */
  wasPriceEligible(
    context: CallContext,
    unit: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
    price: Money,
  ): Promise<Result<{ readonly eligible: boolean }, PromotionsFacadeFailure>>;
}

/** Nest token of the {@link PromotionsFacade}, provided and exported by `PromotionsModule`. */
export const PROMOTIONS_FACADE = Symbol('PROMOTIONS_FACADE');

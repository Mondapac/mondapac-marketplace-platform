import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CalculationOutput } from '../domain/calculation/types';
import type { DiscountSummary } from '../domain/redemption';

export type { DiscountSummary } from '../domain/redemption';

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

/** What checkout asks to redeem: the stored order, its customer, the quote it was priced with. */
export interface RedeemRequest {
  readonly orderId: Id<'Order'>;
  readonly customerAccountId: Id<'Account'>;
  /** The request the order's quote was made with. */
  readonly request: QuoteRequest;
  /** The discounts the stored order holds ({@link discountSummaryOf} of that quote). */
  readonly expected: DiscountSummary;
}

export interface RedeemResult {
  /** `nothing`: the order took no discount; `already-redeemed`: a repeat for the same order. */
  readonly outcome: 'redeemed' | 'already-redeemed' | 'nothing';
}

export type RedeemFacadeFailure =
  | PromotionsFacadeFailure
  /** The discounts changed since the quote (a budget, a limit or a code was taken): nothing was
   * reserved; `quote` is what the order would get now. */
  | { readonly code: 'promotions.quote-changed'; readonly quote: QuoteResult }
  /** The order's redemption was released (it was cancelled): it is never redeemed again. */
  | { readonly code: 'promotions.redemption-released' }
  /** A lock could not be taken in time: nothing was reserved; the caller may try again. */
  | { readonly code: 'conflict.retry' };

/** Why the safety sweep's calls failed: a malformed request, or a read or write to try again. */
export type RedemptionSweepFailure =
  AccessDenied | { readonly code: 'validation.failed' } | { readonly code: 'promotions.try-again' };

/** What the safety sweep says became of an order: paid confirms, cancelled releases. */
export type RedemptionSettlement = 'paid' | 'cancelled';

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
   * The checkout saga's redemption (package T2, rule `system`): after ordering stored the order
   * with the discounts of a {@link quote}, this reserves them in one unit under row locks (usage
   * counters, budgets, the per-customer and flash-sale limits, the first-order month budget, a
   * single-use code), or answers `promotions.quote-changed` with the fresh quote and reserves
   * nothing. Idempotent per order. `ordering.order-paid.v1` confirms the reservation and
   * `ordering.order-cancelled.v1` releases it. In-process.
   */
  redeem(
    context: CallContext,
    request: RedeemRequest,
  ): Promise<Result<RedeemResult, RedeemFacadeFailure>>;

  /**
   * The safety sweep of package T2 (rule `system`): the orders that still hold RESERVED
   * redemptions written before `before`, oldest first, at most `limit` (1 to 100). Ordering
   * settles each by its own order's state, since a crash between the redemption and the payment
   * step leaves no event to do it. In-process.
   */
  staleRedemptions(
    context: CallContext,
    request: { readonly before: Temporal.Instant; readonly limit: number },
  ): Promise<Result<readonly Id<'Order'>[], RedemptionSweepFailure>>;

  /**
   * The safety sweep's settlement of one order (rule `system`): `paid` confirms its RESERVED
   * redemptions, `cancelled` releases them and gives back the counters, budgets and code.
   * Idempotent. In-process.
   */
  settleRedemptions(
    context: CallContext,
    request: { readonly orderId: Id<'Order'>; readonly outcome: RedemptionSettlement },
  ): Promise<
    Result<
      { readonly outcome: 'confirmed' | 'released' | 'nothing' | 'already-handled' },
      RedemptionSweepFailure
    >
  >;

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

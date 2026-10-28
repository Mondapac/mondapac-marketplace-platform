// The types of the pure discount calculation (promotions package T1). Everything here is plain
// data: no Date, no I/O, no Market lookup. Amounts are integer minor units (bigint) of one
// currency, shares are basis points (10000 is all) and quantities are small integers. The caller
// (a use case) turns stored promotions, the cart, the Market config and the entered code into a
// {@link CalculationInput}; the answer is {@link CalculationOutput}.

/** The four layers, in the order they are calculated. Wallet credit is payment, not a layer. */
export const LAYERS = ['ITEM', 'SELLER_CART', 'PLATFORM_CART', 'SHIPPING'] as const;
export type Layer = (typeof LAYERS)[number];

/** The phase 1 promotion types. */
export const PROMOTION_TYPES = [
  /** A seller's sale price on products: percent or fixed amount per unit off. */
  'SELLER_SALE',
  /** An automatic cart discount with a minimum spend (a seller's own, or the platform's). */
  'CART_DISCOUNT',
  /** A cart discount that applies only when its public code is entered. */
  'CART_CODE',
  /** Free or cheaper shipping above a spend threshold, per delivery zone. */
  'FREE_SHIPPING',
  /** The first-order discount, built from the Market's first-order settings. */
  'FIRST_ORDER',
  /** A platform and seller co-funded campaign on the products of opted-in sellers. */
  'CO_FUNDED_CAMPAIGN',
] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export type Reward =
  /** Percent of the base, in basis points. */
  | { readonly kind: 'PERCENT'; readonly bps: number }
  /**
   * A fixed amount. On the ITEM layer it is off each unit; on a cart layer and on shipping it is
   * off the whole base.
   */
  | { readonly kind: 'FIXED'; readonly amount: bigint };

/** One promotion as the calculation sees it (already filtered to the live ones by the caller). */
export interface CalculationPromotion {
  readonly id: string;
  readonly type: PromotionType;
  readonly layer: Layer;
  /**
   * The platform's share of every discount this promotion gives, in basis points: 0 is
   * seller-funded, 10000 is platform-funded, anything between is co-funded. Shipping is always
   * platform-funded whatever is written here.
   */
  readonly platformShareBps: number;
  /** The owner seller; null for a platform promotion. A seller's promotion touches its lines only. */
  readonly sellerId: string | null;
  /** False: this promotion is used alone, never together with another one. */
  readonly combinable: boolean;
  /** Set: the promotion applies only when exactly this (normalised) code is entered. */
  readonly code: string | null;
  /** A campaign flagged by an admin: its platform share is outside the commission cap. */
  readonly specialCampaign: boolean;
  readonly reward: Reward;
  /**
   * The most of its base (the line on the item layer, the eligible goods on a cart layer) this
   * promotion may take, in basis points; null for no limit. Seller promotions carry the Market's
   * seller maximum here, so a fixed amount cannot go beyond it either.
   */
  readonly maxShareBps: number | null;
  /** The most one application may give (for example 20 % up to A$30); null for none. */
  readonly capAmount: bigint | null;
  /** The most the promotion gives in one order; null for none. */
  readonly maxPerOrder: bigint | null;
  /** What is left of the promotion's budget; null for no budget. Reservation is package T2. */
  readonly budgetRemaining: bigint | null;
  /** Minimum spend of the eligible goods (shipping: of the goods net of discounts). */
  readonly minSpend: bigint | null;
  /** Target products; null is any product, an empty list is none. */
  readonly productIds: readonly string[] | null;
  /** Target sellers; null is any seller, an empty list is none. */
  readonly sellerIds: readonly string[] | null;
  /** Target delivery zones (shipping); null is any zone. */
  readonly zones: readonly string[] | null;
  /** Only for a customer whose first order this is. */
  readonly firstOrderOnly: boolean;
}

export interface CartLine {
  readonly id: string;
  readonly sellerId: string;
  readonly productId: string;
  /** Unit price in minor units. */
  readonly unitPrice: bigint;
  readonly quantity: number;
}

export interface ShippingCharge {
  readonly id: string;
  /** The seller the shipping belongs to; null for a charge of the whole order. */
  readonly sellerId: string | null;
  readonly zoneCode: string;
  readonly amount: bigint;
}

/** The Market rules the calculation needs (Market config `promotions`). */
export interface CalculationRules {
  /** The most of one line that all discounts together may take, in basis points. */
  readonly lineDiscountCapBps: number;
}

export interface CalculationInput {
  readonly currency: string;
  readonly lines: readonly CartLine[];
  readonly shipping: readonly ShippingCharge[];
  readonly promotions: readonly CalculationPromotion[];
  /** The one code the customer entered, normalised; null for none. */
  readonly code: string | null;
  readonly isFirstOrder: boolean;
  /** The commission of this order: the platform's share of its discounts is capped by it. */
  readonly orderCommission: bigint;
  readonly rules: CalculationRules;
}

/** One discount on one line (or one shipping charge) with its funding split. */
export interface Allocation {
  readonly promotionId: string;
  readonly layer: Layer;
  readonly amount: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
}

export interface LineResult {
  readonly lineId: string;
  readonly gross: bigint;
  readonly discount: bigint;
  readonly net: bigint;
  readonly allocations: readonly Allocation[];
}

export interface ShippingResult {
  readonly shippingId: string;
  readonly gross: bigint;
  readonly discount: bigint;
  readonly net: bigint;
  readonly allocations: readonly Allocation[];
}

export interface AppliedPromotion {
  readonly promotionId: string;
  readonly layer: Layer;
  readonly amount: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
}

/** What became of the entered code. */
export type CodeOutcome = 'NONE' | 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';

export interface CalculationTotals {
  readonly goodsGross: bigint;
  readonly goodsDiscount: bigint;
  readonly goodsNet: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
  readonly shippingGross: bigint;
  readonly shippingDiscount: bigint;
  readonly shippingNet: bigint;
  /** Goods net plus shipping net: what is left to pay before wallet credit. */
  readonly payable: bigint;
}

export interface CalculationOutput {
  readonly currency: string;
  readonly lines: readonly LineResult[];
  readonly shipping: readonly ShippingResult[];
  readonly applied: readonly AppliedPromotion[];
  readonly code: CodeOutcome;
  readonly totals: CalculationTotals;
}

export type CalculationError = {
  readonly code: 'calculation.invalid-input';
  /** The path of the field that is wrong; never a value. */
  readonly path: string;
};

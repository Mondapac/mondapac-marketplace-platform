// The types of the pure discount calculation (promotions package T1). Everything here is plain
// data: no Date, no I/O, no Market lookup. Amounts are integer minor units (bigint) of one
// currency, shares are basis points (10000 is all) and quantities are small integers. The caller
// (a use case) turns stored promotions, the cart, the Market config and the entered code into a
// {@link CalculationInput}; the answer is {@link CalculationOutput}.

/** The four layers, in the order they are calculated. Wallet credit is payment, not a layer. */
export const LAYERS = ['ITEM', 'SELLER_CART', 'PLATFORM_CART', 'SHIPPING'] as const;
export type Layer = (typeof LAYERS)[number];

/** The promotion types: phase 1, then the phase 2 types after CO_FUNDED_CAMPAIGN, then phase 3. */
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
  /** A platform cart discount by tiers of the goods amount; the highest tier reached applies. */
  'TIERED_CART',
  /** A seller's item offer: buy X, get Y of the cheapest units free or at a discount. */
  'BUY_X_GET_Y',
  /** A seller's item offer: N units for a fixed total price. */
  'MULTI_BUY',
  /** A seller's item offer: a set of its products bought together gets a fixed amount off. */
  'BUNDLE',
  /** An item sale in a time window with a limit of units (a seller's or the platform's). */
  'FLASH_SALE',
  /** A platform cart discount that applies once per generated single-use code. */
  'BATCH_CODE',
  /** A platform cart discount for a customer segment (a returning customer, a delivery zone). */
  'CUSTOMER_GROUP',
  /** A seller's cart discount for the customers who follow its store. */
  'STORE_FOLLOWER',
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

/**
 * Who a promotion is for, beyond the cart. The customer facts come from other modules and may be
 * unknown; a promotion with an audience applies only when the fact it needs is known and says yes
 * (fail closed).
 */
export type Audience =
  /** A customer whose last order was at least this many whole days ago (never ordered: not eligible). */
  | { readonly kind: 'RETURNING_CUSTOMER'; readonly minDaysSinceLastOrder: number }
  /** A cart that is delivered to one of these delivery zones (the cart's shipping charges say which). */
  | { readonly kind: 'DELIVERY_ZONE'; readonly zones: readonly string[] }
  /** A customer who follows the promotion's seller (a promotion with a seller owner only). */
  | { readonly kind: 'STORE_FOLLOWER' };

/**
 * What is known about the customer of the order. A field that is null (or a customer that is
 * null) is unknown: the audience promotions that need it are left out, never guessed.
 */
export interface CustomerFacts {
  /** Whole days since the customer's last order; null when unknown or the customer never ordered. */
  readonly daysSinceLastOrder: number | null;
  /** The sellers (of the cart) whose store the customer follows; null when unknown. */
  readonly followedSellerIds: readonly string[] | null;
}

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
  /**
   * The most of a line's price the seller may pay through this promotion, in basis points; null
   * for no limit. A co-funded campaign carries the Market's seller maximum here: the discount on
   * a line is held so that the seller's share of it (the part the platform does not fund) stays
   * within this share of the line, whatever the reward and the split.
   */
  readonly sellerMaxShareBps?: number | null;
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
  /**
   * TIERED_CART: the tiers, by goods amount (the eligible goods after the earlier layers). The
   * highest tier whose threshold the goods reach gives the reward; `reward` is not used.
   */
  readonly tiers?: readonly Tier[] | null;
  /**
   * BUY_X_GET_Y: of every `buyQty + getQty` qualifying units, the `getQty` cheapest get `reward`
   * (PERCENT off the unit price, 10000 is free; FIXED off the unit price). `maxRepeats` limits the
   * groups in one order; null for no limit.
   */
  readonly buyXGetY?: {
    readonly buyQty: number;
    readonly getQty: number;
    readonly maxRepeats: number | null;
  } | null;
  /**
   * MULTI_BUY: every `groupQty` qualifying units (the cheapest first) cost `groupPrice` together;
   * never more than their own price. `reward` is not used.
   */
  readonly multiBuy?: {
    readonly groupQty: number;
    readonly groupPrice: bigint;
    readonly maxRepeats: number | null;
  } | null;
  /**
   * BUNDLE: one set holds `quantity` units of each item; every complete set takes `amountOff` off
   * the units in it, spread over their lines. `reward` is not used.
   */
  readonly bundle?: {
    readonly items: readonly { readonly productId: string; readonly quantity: number }[];
    readonly amountOff: bigint;
    readonly maxRepeats: number | null;
  } | null;
  /**
   * The units this promotion may still discount in all orders (a flash sale's limit minus the
   * units already sold); null for no limit. One order never discounts more units than this.
   */
  readonly unitLimit?: number | null;
  /** The promotion's single-use code was already redeemed: the entered code matches but gives nothing. */
  readonly codeUsed?: boolean;
  /** Who the promotion is for; absent or null is every customer. */
  readonly audience?: Audience | null;
}

/** One tier of a tiered cart discount. */
export interface Tier {
  /** The goods amount (minor units) from which this tier applies. */
  readonly threshold: bigint;
  readonly reward: Reward;
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
  /** What is known about the customer; absent or null is nothing (audience promotions do not apply). */
  readonly customer?: CustomerFacts | null;
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

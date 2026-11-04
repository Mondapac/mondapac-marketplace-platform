import type { MarketContext } from '@mondapac/shared-kernel';
import type { PromotionRules } from '../../domain/promotion';

/** The first-order discount as the calculation sees it. */
export interface FirstOrderSettings {
  readonly enabled: boolean;
  readonly kind: 'PERCENT' | 'FIXED';
  readonly percentBps: number | null;
  readonly amountMinor: bigint | null;
  readonly capMinor: bigint | null;
  readonly minSpendMinor: bigint;
  readonly monthlyBudgetMinor: bigint;
}

/** Generated single-use codes of the Market (Market config `promotions.batchCodes`). */
export interface BatchCodeSettings {
  readonly codeLength: number;
  readonly alphabet: string;
  readonly maxPerBatch: number;
  readonly maxPerPromotion: number;
}

/** The Market's promotions settings (Market config `promotions`), all in whole units. */
export interface PromotionsSettings {
  /** The currency of every promotion and cart of the Market. */
  readonly currency: string;
  readonly rules: PromotionRules;
  /** All discounts together may take this share of a line, in basis points. */
  readonly lineDiscountCapBps: number;
  /** The Market default free-shipping threshold, minor units. */
  readonly freeShippingThresholdMinor: bigint;
  readonly wasPrice: { readonly windowDays: number; readonly minDaysAtPrice: number };
  /** The most promotions one seller may have active or waiting for approval at once. */
  readonly maxActivePromotionsPerSeller: number;
  /** Null: the Market allows no batches of single-use codes. */
  readonly batchCodes: BatchCodeSettings | null;
  /** The first-order discount until an admin edits it; null when the Market configures none. */
  readonly firstOrderDefaults: FirstOrderSettings | null;
}

export interface PromotionsPolicy {
  /** Null when the Market has no promotions settings: promotions are unavailable (fail closed). */
  settings(market: MarketContext): PromotionsSettings | null;
}

export const PROMOTIONS_POLICY = Symbol('PROMOTIONS_POLICY');

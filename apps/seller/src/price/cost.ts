import type { ApiFailure } from '../api/client.ts';

// The seller's private Cost on the Offer page (Offer page PR 7-UI; pricing design 6.5, ux F41).
// A Cost is read only when the seller presses "Show costs", never with the page, and is never put
// in the URL, in browser storage, in a log or in a toast. Money stays in minor units as text.

/** The answer of `GET pricing/seller/offers/:offerId/costs`. */
export interface OfferCostsBody {
  readonly offerId: string;
  /** The Market currency every Cost is written in. */
  readonly currency: string;
  readonly variants: readonly {
    readonly variantId: string;
    /** `expectedVersion` of the next write; null when no Cost was ever recorded. */
    readonly seriesVersion: number | null;
    /** Null: no Cost recorded (or it was cleared). */
    readonly cost: { readonly amount: string; readonly currency: string } | null;
  }[];
}

/** The answer of `PUT pricing/seller/offers/:offerId/variants/:variantId/cost`. */
export interface CostWritten {
  readonly status: 'recorded' | 'cleared' | 'unchanged';
  readonly seriesVersion: number | null;
}

/** The saved Cost of one size, as the page holds it while costs are shown. */
export interface SavedCost {
  /** Minor units; null when none is recorded. */
  readonly amount: string | null;
  readonly seriesVersion: number | null;
}

/** What the Cost tabs show: hidden (the default), being read, read, or why they can't be. */
export type CostsState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'shown';
      readonly byVariant: Readonly<Record<string, SavedCost>>;
      /** A read again after a save failed: the Costs shown are the last ones read. */
      readonly notice?: CostProblem;
    }
  | { readonly kind: 'failed'; readonly problem: CostProblem };

/** The saved Cost of each size the API answered for; a size it left out takes no Cost. */
export function savedCostsOf(body: OfferCostsBody): Record<string, SavedCost> {
  return Object.fromEntries(
    body.variants.map((variant) => [
      variant.variantId,
      { amount: variant.cost?.amount ?? null, seriesVersion: variant.seriesVersion },
    ]),
  );
}

export type CostProblem =
  | 'acting-as'
  /** The Costs are in another currency than the page's prices: nothing is shown or written. */
  | 'currency'
  | 'denied'
  | 'not-eligible'
  | 'not-found'
  | 'stale'
  | 'retired'
  | 'out-of-range'
  | 'invalid'
  | 'throttled'
  | 'csrf'
  | 'unavailable'
  | 'unknown';

const BY_CODE: Readonly<Record<string, CostProblem>> = {
  'pricing.acting-as-refused': 'acting-as',
  'access.denied': 'denied',
  'access.seller-not-approved': 'not-eligible',
  'seller.not-eligible': 'not-eligible',
  'pricing.offer-not-found': 'not-found',
  'conflict.stale': 'stale',
  'conflict.retry': 'stale',
  'pricing.series-retired': 'retired',
  'pricing.amount-out-of-range': 'out-of-range',
  'pricing.currency-mismatch': 'invalid',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

/** The message key (under `price.cost.error`) of a refused Cost read or write. */
export function costProblemOf(failure: ApiFailure): CostProblem {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** "Estimated profit" of one unit: what the seller receives less their Cost, and its share. */
export interface ProfitEstimate {
  /** Minor units, negative when the Cost is above what the seller receives. */
  readonly profitMinor: string;
  /** The profit as a whole percent of what the customer pays, rounded half away from zero. */
  readonly percent: number | null;
}

const DIGITS = /^\d{1,16}$/;

/**
 * Estimated profit = "You receive (est.)" − Cost, both for one unit at the price customers pay now
 * (design: the base is the customer price, a running special included). Exact: no floating point.
 * Null when an amount is missing or not minor units.
 */
export function profitOf(
  youReceiveMinor: string | null,
  costMinor: string | null,
  customerPaysMinor: string | null,
): ProfitEstimate | null {
  if (youReceiveMinor === null || costMinor === null) return null;
  if (!DIGITS.test(youReceiveMinor) || !DIGITS.test(costMinor)) return null;
  const profit = BigInt(youReceiveMinor) - BigInt(costMinor);
  let percent: number | null = null;
  if (customerPaysMinor !== null && DIGITS.test(customerPaysMinor)) {
    const base = BigInt(customerPaysMinor);
    if (base > 0n) {
      const negative = profit < 0n;
      const scaled = (negative ? -profit : profit) * 100n;
      const rounded = Number((scaled * 2n + base) / (2n * base));
      percent = negative && rounded !== 0 ? -rounded : rounded;
    }
  }
  return { profitMinor: profit.toString(), percent };
}

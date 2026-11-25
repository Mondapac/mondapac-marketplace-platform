import type { OfferView } from './types.ts';

/** The handling a new draft starts with when none of the seller's offers has one (john, 25 Nov). */
export const DEFAULT_HANDLING = 'SEALED_ORIGINAL';

/** What a new draft Offer starts with, and whether it came from the seller's own last offer. */
export interface OfferDefaults {
  readonly condition: string;
  readonly handling: string;
  /** True when the condition and handling were copied from the seller's newest offer that has them. */
  readonly fromLastOffer: boolean;
}

/** The condition a new draft Offer starts with: `new` when the Market has it, else the first. */
export function defaultCondition(conditions: readonly string[]): string | null {
  return conditions.includes('new') ? 'new' : (conditions[0] ?? null);
}

/**
 * The condition and handling of a new draft (Offer page PR 5): those of the seller's newest offer
 * that has its handling recorded (a condition the Market no longer has is not copied), else the
 * Market's default condition and Sealed original. `offers` are newest first. Null when the
 * Market has no condition at all (no draft can be made).
 */
export function offerDefaultsOf(
  offers: readonly Pick<OfferView, 'conditionCode' | 'handling'>[],
  conditions: readonly string[],
): OfferDefaults | null {
  const fallback = defaultCondition(conditions);
  if (fallback === null) return null;
  const last = offers.find((offer) => typeof offer.handling === 'string');
  if (last === undefined || typeof last.handling !== 'string') {
    return { condition: fallback, handling: DEFAULT_HANDLING, fromLastOffer: false };
  }
  return {
    condition:
      typeof last.conditionCode === 'string' && conditions.includes(last.conditionCode)
        ? last.conditionCode
        : fallback,
    handling: last.handling,
    fromLastOffer: true,
  };
}

/** The seller's newest offers the defaults are read from (one keyset page). */
export const DEFAULTS_SOURCE_PATH = 'catalog/seller/offers?limit=25';

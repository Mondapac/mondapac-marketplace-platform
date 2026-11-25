import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  referencePrice,
  type ReferenceCandidate,
  type ReferencePrice,
} from '../../domain/reference-price';
import type {
  FirstPriceCheckStore,
  ReferenceBusinesses,
  ReferenceSettings,
  ReferenceSettingsSource,
  VariantKey,
  VariantPriceReader,
  VariantRegularPrice,
} from '../ports/first-price-reference';
import type { OfferSellUnitsSource, PricedOfferView } from '../ports/offer-sell-units';

/** The ports of R4 (risk-based Offer approval, ADR-0051), bound as one dependency. */
export interface FirstPriceReferencePorts {
  readonly prices: VariantPriceReader;
  readonly businesses: ReferenceBusinesses;
  readonly settings: ReferenceSettingsSource;
  readonly checks: FirstPriceCheckStore;
}
export const FIRST_PRICE_REFERENCE = Symbol('PRICING_FIRST_PRICE_REFERENCE');

export interface VariantReferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferSellUnitsSource;
  readonly clock: Clock;
  readonly reference: FirstPriceReferencePorts;
}

/** A reference candidate with the Offer it came from. */
export interface LiveReferencePrice extends ReferenceCandidate {
  readonly offerId: Id<'Offer'>;
}

/**
 * Everything read about one Variant for R4, once per write: the Market's settings, every regular
 * price in force on the Variant (live or not; the re-check measures earlier Offers by it), and the
 * candidates, the prices of live Offers of eligible sellers.
 */
export type GatheredReference =
  | { readonly kind: 'unavailable'; readonly settings: ReferenceSettings | null }
  | {
      readonly kind: 'gathered';
      readonly settings: ReferenceSettings;
      readonly prices: readonly VariantRegularPrice[];
      readonly candidates: readonly LiveReferencePrice[];
    };

/** At most this many seller ids per `sellingEligibility` call (its own limit). */
const SELLERS_PER_CALL = 100;

const validSettings = (settings: ReferenceSettings): boolean =>
  Number.isSafeInteger(settings.referenceSellers) &&
  settings.referenceSellers >= 1 &&
  Number.isSafeInteger(settings.priceBandPercent) &&
  settings.priceBandPercent >= 1;

/**
 * Reads what R4 needs about one Variant. Facade calls run outside any write unit (P 3.1 row 5);
 * pricing's own prices are read in a read-only unit (ADR-0025). Never throws: a failure of
 * settings, catalog, sellers or the database is `unavailable`, which the caller treats as "no
 * reference" (publish and review after publication), never as "within the band".
 */
export async function gatherVariantReference(
  deps: VariantReferenceDependencies,
  context: CallContext,
  key: VariantKey,
): Promise<GatheredReference> {
  let settings: ReferenceSettings | null = null;
  try {
    settings = await deps.reference.settings.settings(context);
    if (!validSettings(settings)) return { kind: 'unavailable', settings: null };
    const { market } = context;
    const now = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.reference.prices.regularPricesInForce(market, key, now)),
      { readOnly: true },
    );
    if (!read.ok) return { kind: 'unavailable', settings };
    const prices = read.value;
    const offerIds = [...new Set(prices.map((p) => p.offerId))];
    const views: ReadonlyMap<Id<'Offer'>, PricedOfferView> = offerIds.length === 0
      ? new Map()
      : await deps.offers.sellUnitsOf(context, offerIds);
    // Live: catalog says the Variant is on sale on that Offer now, and the Offer is still the
    // seller's that the series names (a moved or foreign Offer is not a reference).
    const live = prices.filter((price) => {
      const view = views.get(price.offerId);
      return (
        view !== undefined &&
        view.sellerId === price.sellerId &&
        view.liveVariantIds.has(key.variantId)
      );
    });
    const sellerIds = [...new Set(live.map((p) => p.sellerId))];
    const eligible = new Set<Id<'Seller'>>();
    for (let start = 0; start < sellerIds.length; start += SELLERS_PER_CALL) {
      const chunk = sellerIds.slice(start, start + SELLERS_PER_CALL);
      for (const id of await deps.reference.businesses.eligibleSellers(context, chunk)) {
        if (chunk.includes(id)) eligible.add(id);
      }
    }
    const candidates = live
      .filter((p) => eligible.has(p.sellerId))
      .map((p) =>
        Object.freeze({ offerId: p.offerId, sellerId: p.sellerId, amountMinor: p.amountMinor }),
      );
    return { kind: 'gathered', settings, prices, candidates };
  } catch {
    return { kind: 'unavailable', settings };
  }
}

/** The reference of the Variant for one seller (R4), with the settings it was decided under. */
export type VariantReference =
  | {
      readonly kind: 'unavailable';
      readonly businessesNeeded: number;
      readonly bandPercent: number;
    }
  | {
      readonly kind: 'no-reference';
      readonly businesses: number;
      readonly businessesNeeded: number;
      readonly bandPercent: number;
    }
  | {
      readonly kind: 'reference';
      readonly reference: ReferencePrice;
      readonly businessesNeeded: number;
      readonly bandPercent: number;
    };

/**
 * The reference as one seller sees it: the seller's own Offers never count (a seller is never
 * their own reference), whatever they list.
 */
export function referenceFor(
  gathered: GatheredReference,
  excludeSellerId: Id<'Seller'>,
): VariantReference {
  if (gathered.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      businessesNeeded: gathered.settings?.referenceSellers ?? 0,
      bandPercent: gathered.settings?.priceBandPercent ?? 0,
    };
  }
  const { referenceSellers, priceBandPercent } = gathered.settings;
  const others = gathered.candidates.filter((c) => c.sellerId !== excludeSellerId);
  const answer = referencePrice(others, referenceSellers);
  return answer.kind === 'reference'
    ? {
        kind: 'reference',
        reference: answer.reference,
        businessesNeeded: referenceSellers,
        bandPercent: priceBandPercent,
      }
    : {
        kind: 'no-reference',
        businesses: answer.businesses,
        businessesNeeded: referenceSellers,
        bandPercent: priceBandPercent,
      };
}

/**
 * The Variant's reference price as one seller would be measured against it now (R4): for the
 * first-price check and for any read that shows a "typical price". The exact median must not be
 * shown to a seller unless their price is outside the band (design 9, Hassan), and such a read is
 * rate-limited by its route.
 */
export async function readVariantReference(
  deps: VariantReferenceDependencies,
  context: CallContext,
  key: VariantKey & { readonly excludeSellerId: Id<'Seller'> },
): Promise<VariantReference> {
  return referenceFor(await gatherVariantReference(deps, context, key), key.excludeSellerId);
}

import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DetailBadge, DetailKey, ProductDetailSources } from './ports/product-detail-sources';
import { detailKeyOf } from './ports/product-detail-sources';

/** At most this many Offers per badge call: catalog's `offerBadges` refuses more than 20. */
export const CARD_BADGE_BATCH = 20;
/** The most seals a card shows (one per certification type): two fit a phone tile. */
export const MAX_CARD_BADGES = 2;
/** How long a list waits for its card facts: past it every card shows none (the list answers). */
export const CARD_FACTS_DEADLINE_MS = 1500;

/**
 * A seal a product card shows: a certification badge built from catalog's live `offerBadges`
 * (an `evaluateClaims` decision there, AI rule R1); search adds nothing and decides nothing. Only
 * a certificate (the seller's or the manufacturer's) is a seal: a seller's own declaration is not
 * one on a card (the product page shows it as a "declared" chip).
 */
export interface CardBadge {
  readonly typeCode: string;
  readonly typeName: string;
  /** The seal artwork key the type's registry entry names (`text`: a plain badge). */
  readonly artworkKey: string;
}

/**
 * What a product card shows beyond the indexed text and price: the seller's public store name,
 * the seals, and "Only N left" for the unit the card carts. Each is absent (`null`, or no seal)
 * when its source cannot answer: a list never fails for them.
 */
export interface CardFacts {
  readonly sellerName: string | null;
  readonly badges: readonly CardBadge[];
  /** Units left of the card's one sell unit, only in inventory's low band; never a count else. */
  readonly onlyLeft: number | null;
}

/** The sources a list reads its card facts from (the product page's, each with the context). */
export type CardFactSource = Pick<ProductDetailSources, 'sellers' | 'availability' | 'badges'>;

interface CardKey {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
}

/** The seals of one Offer's badges: certificates only, one per type, in catalog's order. */
export function cardBadgesOf(badges: readonly DetailBadge[] | undefined): CardBadge[] {
  const seals: CardBadge[] = [];
  for (const badge of badges ?? []) {
    if (badge.sellerClaim) continue;
    if (seals.some((seal) => seal.typeCode === badge.typeCode)) continue;
    seals.push({
      typeCode: badge.typeCode,
      typeName: badge.typeName,
      artworkKey: badge.artworkKey,
    });
    if (seals.length === MAX_CARD_BADGES) break;
  }
  return seals;
}

/** Waits for a source at most `ms`; a refusal, a throw or the deadline is `null`. */
async function within<T>(ms: number, read: () => Promise<T | null>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([read().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The badges of every Offer, asked in batches of {@link CARD_BADGE_BATCH}, one after another. */
async function badgesOf(
  source: CardFactSource,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<ReadonlyMap<Id<'Offer'>, readonly DetailBadge[]> | null> {
  const all = new Map<Id<'Offer'>, readonly DetailBadge[]>();
  for (let start = 0; start < offerIds.length; start += CARD_BADGE_BATCH) {
    const batch = await source.badges(context, offerIds.slice(start, start + CARD_BADGE_BATCH));
    // One batch that cannot answer drops every seal of the list (badges fail closed, all or none).
    if (batch === null) return null;
    for (const [offerId, list] of batch) all.set(offerId, list);
  }
  return all;
}

/**
 * Adds {@link CardFacts} to each item of a list, with one seller read, one stock read and the
 * badge reads for the whole list, all with the request's context unchanged. `unitOf` names the
 * (Offer, Variant) the card carts, or null: only that unit's stock is read, and only its low band
 * is shown. Each source that refuses, fails or is slower than {@link CARD_FACTS_DEADLINE_MS} gives
 * every card none of its fact.
 */
export async function withCardFacts<T extends CardKey>(
  source: CardFactSource,
  context: CallContext,
  items: readonly T[],
  unitOf: (item: T) => Id<'Variant'> | null,
): Promise<(T & CardFacts)[]> {
  if (items.length === 0) return [];
  const offerIds = [...new Set(items.map((item) => item.offerId))];
  const sellerIds = [...new Set(items.map((item) => item.sellerId))];
  const keys: DetailKey[] = items.flatMap((item) => {
    const variantId = unitOf(item);
    return variantId === null ? [] : [{ offerId: item.offerId, variantId }];
  });
  const [sellers, stock, badges] = await Promise.all([
    within(CARD_FACTS_DEADLINE_MS, () => source.sellers(context, sellerIds)),
    keys.length === 0
      ? Promise.resolve(null)
      : within(CARD_FACTS_DEADLINE_MS, () => source.availability(context, keys)),
    within(CARD_FACTS_DEADLINE_MS, () => badgesOf(source, context, offerIds)),
  ]);
  return items.map((item) => {
    const variantId = unitOf(item);
    const unitStock =
      variantId === null
        ? undefined
        : stock?.get(detailKeyOf({ offerId: item.offerId, variantId }));
    const storeName = sellers?.get(item.sellerId)?.storeName;
    return {
      ...item,
      sellerName: typeof storeName === 'string' && storeName.trim() !== '' ? storeName : null,
      badges: cardBadgesOf(badges?.get(item.offerId)),
      onlyLeft:
        unitStock?.status === 'low' && unitStock.onlyLeft !== null ? unitStock.onlyLeft : null,
    };
  });
}

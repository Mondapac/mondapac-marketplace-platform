import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  clip,
  MAX_DOCUMENT_CATEGORIES,
  MAX_DOCUMENT_VARIANTS,
  MAX_FACET_CODES,
  MAX_NAME,
  MAX_SHORT_TEXT,
  MAX_VARIANT_FACETS,
  type OfferDocument,
} from '../domain/offer-document';
import type { FeedFacts } from './ports/offer-feed';
import { sellUnitRefKey, type SellUnitRef, type SellUnitState } from './ports/sell-unit-states';
import type { SearchDependencies } from './search-dependencies';

/** Offers per catalog read (its facade takes at most 200). */
export const SYNC_BATCH = 200;

export interface SyncCounts {
  readonly upserted: number;
  readonly deleted: number;
}

const NO_STATE: SellUnitState = { inStock: false, price: null };

/** Whether an Offer can have a document (before its text is checked). Pure. */
const indexable = (
  facts: FeedFacts | undefined,
  eligibleSellers: ReadonlySet<Id<'Seller'>>,
): facts is FeedFacts =>
  facts !== undefined &&
  facts.sellable &&
  facts.name !== null &&
  eligibleSellers.has(facts.sellerId);

/**
 * The document of an Offer, or null when it must not be indexed: catalog says it is not
 * sellable, its seller may not sell now (suspended, for one), or the published revision has no
 * text in the Market's locale. Each published variant becomes a sell unit with the stock and price
 * `states` hold for it (absent: out of stock, unpriced). Pure.
 */
export function documentOf(
  offerId: Id<'Offer'>,
  facts: FeedFacts | undefined,
  settings: { readonly locale: string; readonly textSearchConfig: string },
  eligibleSellers: ReadonlySet<Id<'Seller'>>,
  states: ReadonlyMap<string, SellUnitState> = new Map(),
): OfferDocument | null {
  if (!indexable(facts, eligibleSellers) || facts.name === null) return null;
  const name = clip(facts.name, MAX_NAME);
  if (name === '') return null;
  const shortText = facts.shortText === null ? '' : clip(facts.shortText, MAX_SHORT_TEXT);
  return {
    offerId,
    productId: facts.productId,
    sellerId: facts.sellerId,
    locale: settings.locale,
    name,
    shortText: shortText === '' ? null : shortText,
    categoryIds: [...new Set(facts.categoryIds)].slice(0, MAX_DOCUMENT_CATEGORIES),
    textSearchConfig: settings.textSearchConfig,
    searchText: facts.attributes.searchText === '' ? null : facts.attributes.searchText,
    facetCodes: [...new Set(facts.attributes.facets)].slice(0, MAX_FACET_CODES),
    numbers: facts.attributes.numbers,
    variants: facts.variants.slice(0, MAX_DOCUMENT_VARIANTS).map((variant) => {
      const state =
        states.get(sellUnitRefKey({ offerId, variantId: variant.variantId })) ?? NO_STATE;
      return {
        variantId: variant.variantId,
        position: variant.position,
        facetCodes: [...new Set(variant.facets)].slice(0, MAX_VARIANT_FACETS),
        gtin: variant.gtin,
        inStock: state.inStock,
        price: state.price,
      };
    }),
  };
}

/**
 * Brings the documents of these Offers in line with catalog and sellers: re-reads each Offer's
 * current state through the index facade (never trusts an event's payload for content), asks
 * the may-sell contract about their sellers and inventory and pricing about their sell units, then upserts the sellable ones and deletes the
 * others in one write unit. Idempotent, so a repeated or
 * out-of-order delivery converges. A failed read or write throws (the delivery is retried).
 */
export async function syncOffers(
  deps: SearchDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<SyncCounts> {
  const { market } = context;
  const settings = deps.policy.settings(market);
  const unique = [...new Set(offerIds)];
  let upserted = 0;
  let deleted = 0;
  for (let at = 0; at < unique.length; at += SYNC_BATCH) {
    const batch = unique.slice(at, at + SYNC_BATCH);
    const facts = await deps.feed.facts(context, batch, settings.locale);
    if (facts === null) throw new Error('search: catalog facts unavailable');
    const sellerIds = [
      ...new Set([...facts.values()].filter((f) => f.sellable).map((f) => f.sellerId)),
    ];
    const eligible =
      sellerIds.length === 0
        ? new Set<Id<'Seller'>>()
        : await deps.sellers.eligible(context, sellerIds);
    if (eligible === null) throw new Error('search: seller eligibility unavailable');
    // The stock and price of every variant of the Offers that will have a document (V8).
    const units: SellUnitRef[] = batch.flatMap((offerId) => {
      const fact = facts.get(offerId);
      return indexable(fact, eligible)
        ? fact.variants
            .slice(0, MAX_DOCUMENT_VARIANTS)
            .map((variant) => ({ offerId, variantId: variant.variantId }))
        : [];
    });
    const states = units.length === 0 ? new Map() : await deps.sellUnits.states(context, units);
    if (states === null) throw new Error('search: stock or price unavailable');
    const documents: OfferDocument[] = [];
    const removals: Id<'Offer'>[] = [];
    for (const offerId of batch) {
      const document = documentOf(offerId, facts.get(offerId), settings, eligible, states);
      if (document === null) removals.push(offerId);
      else documents.push(document);
    }
    const indexedAt = deps.clock.now();
    const written = await deps.unitOfWork.run(market, async () => {
      for (const document of documents) await deps.documents.upsert(market, document, indexedAt);
      const removed = await deps.documents.deleteMany(market, removals);
      return ok(removed);
    });
    if (!written.ok) throw new Error('search: the index write failed');
    upserted += documents.length;
    deleted += written.value;
  }
  return { upserted, deleted };
}

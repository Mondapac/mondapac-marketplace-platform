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
import { categoryNamesOf, composeSearchText } from '../domain/index-names';
import type { NamedCategory } from '../domain/scope-counts';
import type { StoreDocument } from '../domain/store-document';
import type { FeedFacts } from './ports/offer-feed';
import type { PublicStore } from './ports/store-directory';
import { sellUnitRefKey, type SellUnitRef, type SellUnitState } from './ports/sell-unit-states';
import type { SearchDependencies } from './search-dependencies';

/** Offers per catalog read (its facade takes at most 200). */
export const SYNC_BATCH = 200;

export interface SyncCounts {
  readonly upserted: number;
  readonly deleted: number;
}

const NO_STATE: SellUnitState = { inStock: false, price: null };

/** The names that join a document's searchable text: public store names and the live category tree. */
export interface IndexLabels {
  readonly storeNames: ReadonlyMap<Id<'Seller'>, string>;
  readonly tree: readonly NamedCategory[];
}
const NO_LABELS: IndexLabels = { storeNames: new Map(), tree: [] };

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
 * `states` hold for it (absent: out of stock, unpriced). A price in another currency than the
 * Market's is stored as no price: the price filter compares minor units of one currency. The
 * seller's public store name and the names of the product's categories (all levels, from the live
 * tree) join the searchable text at weight C (search 1a). Pure.
 */
export function documentOf(
  offerId: Id<'Offer'>,
  facts: FeedFacts | undefined,
  settings: {
    readonly locale: string;
    readonly textSearchConfig: string;
    readonly currency: string;
  },
  eligibleSellers: ReadonlySet<Id<'Seller'>>,
  states: ReadonlyMap<string, SellUnitState> = new Map(),
  labels: IndexLabels = NO_LABELS,
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
    searchText: composeSearchText(
      facts.attributes.searchText,
      labels.storeNames.get(facts.sellerId) ?? null,
      categoryNamesOf(facts.categoryIds, labels.tree),
    ),
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
        price: state.price?.currency === settings.currency ? state.price : null,
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
    // The names that make a store or a category findable through its products (search 1a). A
    // failed read throws, so the delivery is retried rather than indexing without names.
    const sellersOfDocuments = [
      ...new Set([...facts.values()].filter((f) => indexable(f, eligible)).map((f) => f.sellerId)),
    ];
    const stores: ReadonlyMap<Id<'Seller'>, PublicStore> | null =
      sellersOfDocuments.length === 0
        ? new Map<Id<'Seller'>, PublicStore>()
        : await deps.storeDirectory.publicStores(context, sellersOfDocuments);
    if (stores === null) throw new Error('search: store names unavailable');
    const tree = await deps.categoryTree.tree(context);
    if (tree === null) throw new Error('search: category tree unavailable');
    const labels: IndexLabels = {
      storeNames: new Map([...stores].map(([sellerId, store]) => [sellerId, store.name])),
      tree,
    };
    const documents: OfferDocument[] = [];
    const removals: Id<'Offer'>[] = [];
    for (const offerId of batch) {
      const document = documentOf(offerId, facts.get(offerId), settings, eligible, states, labels);
      if (document === null) removals.push(offerId);
      else documents.push(document);
    }
    const indexedAt = deps.clock.now();
    // The store rows follow the same facts (search 1a): a seller of a document that has a public
    // store is written; a seller met in the batch that has none (suspended, unapproved, no address)
    // is removed. A seller with no Offer left keeps a stale row that no query returns (the store
    // query needs an indexed Offer) and the rebuild deletes it.
    const storeRows: StoreDocument[] = sellersOfDocuments.flatMap((sellerId) => {
      const store = stores.get(sellerId);
      return store === undefined
        ? []
        : [
            {
              sellerId,
              slug: store.slug,
              name: store.name,
              textSearchConfig: settings.textSearchConfig,
            },
          ];
    });
    const storeRemovals = [
      ...new Set(
        [...facts.values()].map((f) => f.sellerId).filter((sellerId) => !stores.has(sellerId)),
      ),
    ];
    const written = await deps.unitOfWork.run(market, async () => {
      for (const document of documents) await deps.documents.upsert(market, document, indexedAt);
      const removed = await deps.documents.deleteMany(market, removals);
      await deps.storeDocuments.upsertMany(market, storeRows, indexedAt);
      await deps.storeDocuments.deleteMany(market, storeRemovals);
      return ok(removed);
    });
    if (!written.ok) throw new Error('search: the index write failed');
    upserted += documents.length;
    deleted += written.value;
  }
  return { upserted, deleted };
}

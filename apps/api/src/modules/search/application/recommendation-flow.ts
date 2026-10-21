import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OfferHit } from '../domain/offer-document';
import type { SearchValidationFailed } from '../domain/search-query';
import { parseShelfQuery } from '../domain/shelf-query';
import type { PrivacySignals } from './ports/personal-signals';
import type { RecommendationDependencies } from './recommendation-dependencies';
import { FILL_DEPTH, itemOf, RANKED_DEPTH } from './use-cases/list-bestsellers.use-case';
import type { ProductSearchItem } from './use-cases/search-products.use-case';

// The personal shelves of personalization package 1d-1: "for you" and "recently viewed". Both read
// the shopper's recent views from engagement (ids only; empty under Global Privacy Control, with
// the customer's switch off or for a guest without consent) and re-check every Offer with catalog
// and sellers before it is shown, exactly as the best-sellers shelf does.

/** The viewed products whose categories feed "for you": the newest ones only. */
export const SIGNAL_PRODUCTS = 20;
/** The most Offers read for each viewed product (the first sellable one is shown). */
export const OFFERS_PER_VIEWED_PRODUCT = 10;

export interface PersonalShelfInput {
  readonly limit?: number | undefined;
  readonly privacy: PrivacySignals;
}

export interface PersonalShelf {
  readonly items: readonly ProductSearchItem[];
}

export type PersonalShelfFailure = SearchValidationFailed | { readonly code: 'search.unavailable' };

const UNAVAILABLE = { code: 'search.unavailable' } as const;

/**
 * "For you": the Market's best sellers in the categories the shopper viewed (and the categories
 * of the products they viewed) first, then the rest of the Market's best sellers, then the
 * browse-order fill, each Offer once. A category that certification marks is never a signal, and
 * no certification tag is ever read. With no views (no data, Global Privacy Control, switch off,
 * no consent, or a source that failed) the answer is the Market's best sellers, as the public
 * shelf gives them. A failed ordering source or a failed catalog or sellers check is
 * `search.unavailable`.
 */
export async function listForYou(
  deps: RecommendationDependencies,
  context: CallContext,
  input: PersonalShelfInput,
): Promise<Result<PersonalShelf, PersonalShelfFailure>> {
  const query = parseShelfQuery({ limit: input.limit });
  if (!query.ok) return query;
  const { limit } = query.value;
  const { market } = context;

  // A refused or failed read of the views is the same as no views: nothing personal is used.
  const views = await deps.signals.recentViews(context, input.privacy);
  const hasViews = views !== null && (views.productIds.length > 0 || views.categoryIds.length > 0);
  // Without the list of certified categories no category is known to be safe: no signal.
  const certified = hasViews ? await deps.signals.certifiedCategoryIds(context) : null;
  const viewedProducts = certified === null || views === null ? [] : views.productIds;

  const ranked = await deps.sources.bestSellingOfferIds(context, RANKED_DEPTH);
  if (ranked === null) return err(UNAVAILABLE);
  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const viewed = await deps.shelves.byProductIds(
        market,
        viewedProducts.slice(0, SIGNAL_PRODUCTS),
        1, // a product's categories are the same on each of its Offers
      );
      const documents = await deps.shelves.byOfferIds(market, ranked);
      const fill = await deps.shelves.browseAll(market, FILL_DEPTH);
      return ok({ viewed, documents, fill });
    },
    { readOnly: true },
  );
  if (!read.ok) return err(UNAVAILABLE);

  const signals = new Set<Id<'Category'>>();
  if (certified !== null && views !== null) {
    for (const categoryId of [
      ...views.categoryIds,
      ...read.value.viewed.flatMap((hit) => hit.categoryIds),
    ]) {
      if (!certified.has(categoryId)) signals.add(categoryId);
    }
  }

  const byId = new Map(read.value.documents.map((hit) => [hit.offerId, hit] as const));
  const rankedHits = ranked.flatMap((offerId) => {
    const hit = byId.get(offerId);
    return hit === undefined ? [] : [hit];
  });
  const inSignal = (hit: OfferHit) => hit.categoryIds.some((id) => signals.has(id));
  const ordered = [
    ...rankedHits.filter(inSignal),
    ...rankedHits.filter((hit) => !inSignal(hit)),
    ...read.value.fill,
  ];
  const seen = new Set<Id<'Offer'>>();
  const candidates = ordered.filter((hit) => {
    if (seen.has(hit.offerId)) return false;
    seen.add(hit.offerId);
    return true;
  });
  const visible = await deps.visibility.visible(context, candidates);
  if (visible === null) return err(UNAVAILABLE);
  return ok({
    items: candidates
      .filter((hit) => visible.has(hit.offerId))
      .slice(0, limit)
      .map(itemOf),
  });
}

/**
 * "Recently viewed": the products the shopper viewed that are sellable now, newest view first,
 * each once, shown through its first Offer that catalog and sellers show now. Empty when there
 * are no views (no data, Global Privacy Control, switch off, no consent). Certification is not a
 * filter here: the shopper viewed these products themselves. A failed read of the views or a
 * failed catalog or sellers check is `search.unavailable`.
 */
export async function listRecentlyViewed(
  deps: RecommendationDependencies,
  context: CallContext,
  input: PersonalShelfInput,
): Promise<Result<PersonalShelf, PersonalShelfFailure>> {
  const query = parseShelfQuery({ limit: input.limit });
  if (!query.ok) return query;
  const { limit } = query.value;
  const { market } = context;

  const views = await deps.signals.recentViews(context, input.privacy);
  if (views === null) return err(UNAVAILABLE);
  if (views.productIds.length === 0) return ok({ items: [] });

  const read = await deps.unitOfWork.run(
    market,
    async () =>
      ok(await deps.shelves.byProductIds(market, views.productIds, OFFERS_PER_VIEWED_PRODUCT)),
    { readOnly: true },
  );
  if (!read.ok) return err(UNAVAILABLE);
  const documents = read.value;

  const visible = await deps.visibility.visible(context, documents);
  if (visible === null) return err(UNAVAILABLE);
  const items: ProductSearchItem[] = [];
  for (const productId of views.productIds) {
    const shown = documents.find((hit) => hit.productId === productId && visible.has(hit.offerId));
    if (shown !== undefined) items.push(itemOf(shown));
    if (items.length === limit) break;
  }
  return ok({ items });
}

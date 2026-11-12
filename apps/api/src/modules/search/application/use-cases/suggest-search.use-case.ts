import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ImageRef } from '../../domain/image-ref';
import type { NamedCategory } from '../../domain/scope-counts';
import type { SearchValidationFailed } from '../../domain/search-query';
import {
  MAX_SUGGEST_CANDIDATE_OFFERS,
  MAX_SUGGEST_CANDIDATE_STORES,
  MAX_SUGGEST_PRODUCTS,
  MAX_SUGGEST_SCOPE_PRODUCTS,
  MAX_SUGGEST_STORES,
  parseSuggestQuery,
  type SuggestQuery,
} from '../../domain/suggest-query';
import { withPrimaryImages } from '../product-images';
import type { SuggestCandidates } from '../ports/suggest-cache';
import type { SuggestDependencies } from '../suggest-dependencies';

/** What a visitor asked, as the transport hands it over: text, not yet checked. */
export interface SuggestSearchRequest {
  readonly q?: string | undefined;
}

/** One product row of the panel. No price and no certification text, by rule. */
export interface SuggestProduct {
  /** The product page's id (the same id `GET /search/products` links with). */
  readonly productId: Id<'Product'>;
  readonly name: string;
  /** The public name of the store of the shown Offer. */
  readonly sellerName: string;
  readonly categoryName: string | null;
  /** The first public photo of the product, or null; the same shape as the search's `primaryImage`. */
  readonly image: ImageRef | null;
}

/** One store row of the panel. */
export interface SuggestStore {
  readonly storeSlug: string;
  readonly name: string;
  /** Indexed (sellable) Offers of the store, one per product it sells. */
  readonly productCount: number;
}

export interface SuggestAnswer {
  readonly products: SuggestProduct[];
  readonly stores: SuggestStore[];
  /** Products in the query's scope, as `GET /search/products` counts them; a floor when capped. */
  readonly total: number;
  readonly totalIsCapped: boolean;
}

export type SuggestSearchFailure = SearchValidationFailed | { readonly code: 'search.unavailable' };

/** How deep a category sits in the live tree (a cycle or a missing parent ends the walk). */
function depthOf(node: NamedCategory, nodes: ReadonlyMap<Id<'Category'>, NamedCategory>): number {
  let depth = 0;
  const seen = new Set<Id<'Category'>>([node.id]);
  let current = node.parentId === null ? undefined : nodes.get(node.parentId);
  while (current !== undefined && !seen.has(current.id)) {
    depth += 1;
    seen.add(current.id);
    current = current.parentId === null ? undefined : nodes.get(current.parentId);
  }
  return depth;
}

/**
 * The category line of a product: the category whose name has a typed word (so "tea" shows Tea, not
 * an unrelated second category), else the deepest category, ties by name then id: never the
 * order the document happens to list them in. Null when the tree knows none of them.
 */
export function categoryNameOf(
  categoryIds: readonly Id<'Category'>[],
  nodes: ReadonlyMap<Id<'Category'>, NamedCategory>,
  words: readonly string[],
): string | null {
  const known = categoryIds.flatMap((id) => {
    const node = nodes.get(id);
    return node === undefined ? [] : [node];
  });
  const matched = known.filter((node) => {
    const name = node.name.toLowerCase();
    return words.some((word) => name.includes(word));
  });
  const pool = matched.length > 0 ? matched : known;
  const best = [...pool].sort(
    (a, b) =>
      depthOf(b, nodes) - depthOf(a, nodes) ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : 1),
  )[0];
  return best?.name ?? null;
}

const EMPTY: SuggestAnswer = { products: [], stores: [], total: 0, totalIsCapped: false };

/**
 * `search.suggest-search`: the header suggestions (search 1b). Rule `anonymous`, the Market is the
 * request's. `q` shorter than 2 characters (or with no letter or digit) answers empty with no index
 * call; longer than 100 characters, with a control character or with more than 8 words it is
 * `validation.failed`. Every typed word must match (product name, store name or category, all in the
 * index text), the last one as a prefix. Products come one per product, in the order name starts
 * with the query, name has every word (stems, punctuation and word order do not matter), seller or
 * category only (`ts_rank` breaks ties), at most 5;
 * stores at most 3 in the same order, with their indexed Offer count; `total` is the product count of
 * the scope. The index side (Offer candidates, total, store candidates and counts) is cached for
 * a few seconds by Market and query; what is shown never is: catalog and sellers re-check every
 * Offer on every call (the same `PublicVisibility` as the search), sellers gives the live store name
 * and address, and a check that cannot be made is `search.unavailable`, never an unchecked list.
 * Photos and category names are decoration: a source that fails leaves them out.
 */
export class SuggestSearch extends UseCase<
  SuggestSearchRequest,
  SuggestAnswer,
  SuggestSearchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.suggest-search',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SuggestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SuggestSearchRequest,
  ): Promise<Result<SuggestAnswer, SuggestSearchFailure>> {
    const parsed = parseSuggestQuery(input.q);
    if (!parsed.ok) return parsed;
    if (parsed.value.kind === 'empty') return ok(EMPTY);
    const { query } = parsed.value;
    const { market } = context;
    const { textSearchConfig } = this.deps.policy.settings(market);

    // The canonical query text: punctuation and case variants of a query share an entry.
    const key = `${market.marketId}|${query.tsQuery}`;
    let candidates = await this.deps.cache.get(key);
    if (candidates === undefined) {
      const read = await this.#readIndex(context, textSearchConfig, query);
      if (read === null) return err({ code: 'search.unavailable' });
      candidates = read;
      await this.deps.cache.set(key, candidates);
    }

    // The live part, never cached: the same visibility check as the search, then the store directory.
    const visible = await this.deps.visibility.visible(
      context,
      candidates.offers.map(({ offerId, sellerId }) => ({ offerId, sellerId })),
    );
    if (visible === null) return err({ code: 'search.unavailable' });
    const shownOffers = candidates.offers.filter((offer) => visible.has(offer.offerId));
    const live = await this.deps.storeDirectory.publicStores(context, [
      ...new Set([
        ...shownOffers.map((offer) => offer.sellerId),
        ...candidates.stores.map(({ hit }) => hit.sellerId),
      ]),
    ]);
    if (live === null) return err({ code: 'search.unavailable' });

    const seen = new Set<Id<'Product'>>();
    const picked: {
      productId: Id<'Product'>;
      name: string;
      sellerName: string;
      categoryIds: readonly Id<'Category'>[];
    }[] = [];
    for (const offer of shownOffers) {
      if (picked.length >= MAX_SUGGEST_PRODUCTS) break;
      const store = live.get(offer.sellerId);
      if (store === undefined || seen.has(offer.productId)) continue;
      seen.add(offer.productId);
      picked.push({
        productId: offer.productId,
        name: offer.name,
        sellerName: store.name,
        categoryIds: offer.categoryIds,
      });
    }
    const [withImages, tree] = await Promise.all([
      withPrimaryImages(this.deps.images, context, picked),
      picked.length === 0 ? Promise.resolve(null) : this.deps.categoryTree.tree(context),
    ]);
    const nodes = new Map((tree ?? []).map((node) => [node.id, node]));
    const products = withImages.map((item): SuggestProduct => ({
      productId: item.productId,
      name: item.name,
      sellerName: item.sellerName,
      categoryName: categoryNameOf(item.categoryIds, nodes, query.words),
      image: item.primaryImage,
    }));
    const stores = candidates.stores.flatMap(({ hit, productCount }): SuggestStore[] => {
      const store = live.get(hit.sellerId);
      return store === undefined || productCount === 0
        ? []
        : [{ storeSlug: store.slug, name: store.name, productCount }];
    });
    return ok({
      products,
      stores: stores.slice(0, MAX_SUGGEST_STORES),
      total: candidates.total,
      totalIsCapped: candidates.totalIsCapped,
    });
  }

  /** One read-only unit: Offer candidates, the product total, store candidates with their counts. */
  async #readIndex(
    context: CallContext,
    textSearchConfig: string,
    query: SuggestQuery,
  ): Promise<SuggestCandidates | null> {
    const { market } = context;
    const request = { textSearchConfig, query };
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const offers = await this.deps.index.suggestOffers(
          market,
          request,
          MAX_SUGGEST_CANDIDATE_OFFERS,
        );
        const rows = await this.deps.index.suggestScopeRows(market, request);
        const hits = await this.deps.index.suggestStores(
          market,
          request,
          MAX_SUGGEST_CANDIDATE_STORES,
        );
        const counts = await this.deps.storeDocuments.offerCounts(
          market,
          hits.map((hit) => hit.sellerId),
        );
        // One row per product: the count is the rows, a floor when the cap was passed.
        const capped = rows.length > MAX_SUGGEST_SCOPE_PRODUCTS;
        const candidates: SuggestCandidates = {
          offers,
          total: capped ? MAX_SUGGEST_SCOPE_PRODUCTS : rows.length,
          totalIsCapped: capped,
          stores: hits.map((hit) => ({ hit, productCount: counts.get(hit.sellerId) ?? 0 })),
        };
        return ok(candidates);
      },
      { readOnly: true },
    );
    return read.ok ? read.value : null;
  }
}

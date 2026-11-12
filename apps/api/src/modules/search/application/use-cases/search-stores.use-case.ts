import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseSearchQuery, type SearchValidationFailed } from '../../domain/search-query';
import type { SearchDependencies } from '../search-dependencies';

/** What a visitor asked, as the transport hands it over: text, not yet checked. */
export interface SearchStoresRequest {
  readonly q?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

/** One store of the answer: its address, public name and how many Offers it has in the index. */
export interface StoreSearchItem {
  readonly slug: string;
  readonly name: string;
  /** Indexed (sellable) Offers of the store, one per product it sells. */
  readonly productCount: number;
}

export interface StoreSearchPage {
  readonly items: readonly StoreSearchItem[];
  readonly page: number;
  readonly pageSize: number;
  /** Whether the next store is visible; a hidden match never changes it. */
  readonly hasMore: boolean;
}

export type SearchStoresFailure = SearchValidationFailed | { readonly code: 'search.unavailable' };

/**
 * `search.search-stores`: the store query (search 1a). Rule `anonymous`, the Market is the request's.
 * `q` has the same shape as the product search (2 to 100 characters, at most 8 OR terms). One
 * read-only unit asks the store read model for `pageSize + 1` stores whose public name matches
 * (ranked, ties by seller id) and that have an indexed Offer; sellers is then asked which of them are
 * public stores now (an approved revision, a held address, may sell now), and the answer uses its
 * name and address, so a store that was suspended or renamed since indexing never shows stale. The
 * count is of indexed Offers (sellable ones), not re-checked one by one. A failed check is
 * `search.unavailable`, never an unchecked list. Address, name and count only.
 */
export class SearchStores extends UseCase<
  SearchStoresRequest,
  StoreSearchPage,
  SearchStoresFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.search-stores',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchStoresRequest,
  ): Promise<Result<StoreSearchPage, SearchStoresFailure>> {
    const parsed = parseSearchQuery({
      q: input.q,
      page: input.page,
      pageSize: input.pageSize,
    });
    if (!parsed.ok) return parsed;
    const { text, page, pageSize } = parsed.value;
    if (text === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'required' }] });
    }
    const { market } = context;
    const { textSearchConfig } = this.deps.policy.settings(market);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const hits = await this.deps.index.searchStores(market, {
          textSearchConfig,
          text,
          limit: pageSize + 1,
          offset: (page - 1) * pageSize,
        });
        const counts = await this.deps.storeDocuments.offerCounts(
          market,
          hits.map((hit) => hit.sellerId),
        );
        return ok({ hits, counts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'search.unavailable' });
    const { hits, counts } = read.value;
    const live = await this.deps.storeDirectory.publicStores(
      context,
      hits.map((hit) => hit.sellerId),
    );
    if (live === null) return err({ code: 'search.unavailable' });
    const items = hits.slice(0, pageSize).flatMap((hit) => {
      const store = live.get(hit.sellerId);
      const productCount = counts.get(hit.sellerId) ?? 0;
      return store === undefined || productCount === 0
        ? []
        : [{ slug: store.slug, name: store.name, productCount }];
    });
    const extra = hits[pageSize];
    return ok({
      items,
      page,
      pageSize,
      hasMore: extra !== undefined && live.has(extra.sellerId),
    });
  }
}

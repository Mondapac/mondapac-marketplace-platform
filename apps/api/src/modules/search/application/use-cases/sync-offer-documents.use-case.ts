import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SearchDependencies } from '../search-dependencies';
import { syncOffers, SYNC_BATCH, type SyncCounts } from '../sync-offers';

/** Which Offers to bring in line: some by id, or every Offer of one product or of one seller. */
export type SyncOfferDocumentsInput =
  | { readonly offerIds: readonly Id<'Offer'>[] }
  | { readonly productId: Id<'Product'> }
  | {
      readonly sellerId: Id<'Seller'>;
      /**
       * The seller was just approved, so sellers must already show a public store (its name and
       * address). Sellers records them in a unit after identity's approval commits, so the event
       * can arrive first: then the call throws and the delivery is retried, rather than indexing
       * the seller's Offers without the store name (Mojtaba D4 on #832).
       */
      readonly publicStoreRequired?: true;
    }
  /**
   * The Offers whose document names this category or one under it (a rename or a move; from
   * package 3a also a culture's mark or visibility change on it, and a merge or an archive).
   * `handOffAbove`: the change is one the full reindex also picks up when asked (the culture
   * cases), so past {@link CATEGORY_DIRECT_PAGES} pages the call stops and answers `handedOff`
   * instead of reading on; the subscriber then asks for the reindex. Without it every page is read.
   */
  | { readonly categoryId: Id<'Category'>; readonly handOffAbove?: true };

/** The most pages of one product's or seller's Offers read in one call (a safety stop). */
const MAX_PRODUCT_PAGES = 50;

/** Pages of a category subtree synced directly before a culture change is handed to the reindex. */
export const CATEGORY_DIRECT_PAGES = 5;

/** What one call did; `handedOff` when a category scope stopped at the threshold (see the input). */
export type SyncOfferDocumentsResult = SyncCounts & { readonly handedOff?: true };

/**
 * `search.sync-offer-documents`: the handler of the catalog event subscriptions (offer
 * published, deleted or moved; product revision published) and of identity's seller access
 * suspended and reinstated. Rule `system`; the Market comes from
 * the envelope (the context). The event only says which Offers to look at: the content is
 * re-read from catalog, so deliveries may repeat and arrive in any order. Logs ids and counts.
 */
export class SyncOfferDocuments extends UseCase<
  SyncOfferDocumentsInput,
  SyncOfferDocumentsResult,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.sync-offer-documents',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SyncOfferDocuments');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SyncOfferDocumentsInput,
  ): Promise<Result<SyncOfferDocumentsResult, never>> {
    if ('sellerId' in input && input.publicStoreRequired === true) {
      const stores = await this.deps.storeDirectory.publicStores(context, [input.sellerId]);
      if (stores === null) throw new Error('search: store names unavailable');
      if (!stores.has(input.sellerId)) {
        throw new Error('search: the approved seller has no public store yet');
      }
    }
    const { offers, upserted, deleted, handedOff } =
      'offerIds' in input
        ? {
            offers: input.offerIds.length,
            handedOff: false,
            ...(await syncOffers(this.deps, context, input.offerIds)),
          }
        : 'categoryId' in input
          ? await this.#syncCategory(context, input.categoryId, input.handOffAbove === true)
          : { handedOff: false, ...(await this.#syncScope(context, input)) };
    const counts = { upserted, deleted };
    this.#logger.log({
      msg: 'search.documents-synced',
      offers,
      ...counts,
      ...(handedOff ? { handedOff } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(handedOff ? { ...counts, handedOff: true } : counts);
  }

  /**
   * A category was renamed or moved, or a culture's mark, a merge or an archive touched it:
   * re-syncs the Offers whose document names it or a category under it, page by page in Offer id
   * order (keyset, never one unbounded read). Offers with no document have nothing to refresh; a
   * published Offer not yet indexed is picked up by its own events and the rebuild. With
   * `handOff`, past {@link CATEGORY_DIRECT_PAGES} pages it stops and answers `handedOff` (never a
   * throw on size).
   */
  async #syncCategory(
    context: CallContext,
    categoryId: Id<'Category'>,
    handOff: boolean,
  ): Promise<SyncCounts & { readonly offers: number; readonly handedOff: boolean }> {
    const { market } = context;
    const subtree = await this.deps.categories.subtreeOf(context, categoryId);
    if (subtree === null) throw new Error('search: category tree unavailable');
    let offers = 0;
    let upserted = 0;
    let deleted = 0;
    let after: Id<'Offer'> | undefined;
    for (let page = 0; ; page += 1) {
      if (handOff && page >= CATEGORY_DIRECT_PAGES) {
        return { offers, upserted, deleted, handedOff: true };
      }
      const ids = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(await this.deps.documents.offerIdsInCategories(market, subtree, SYNC_BATCH, after)),
        { readOnly: true },
      );
      if (!ids.ok) throw new Error('search: the index read failed');
      const counts = await syncOffers(this.deps, context, ids.value);
      offers += ids.value.length;
      upserted += counts.upserted;
      deleted += counts.deleted;
      if (ids.value.length < SYNC_BATCH) return { offers, upserted, deleted, handedOff: false };
      after = ids.value[ids.value.length - 1];
    }
  }

  /**
   * Syncs the product's or seller's Offers that have a document first (so a suspension removes
   * them at any size), then catalog's published ones page by page. An Offer in both is synced
   * twice, which converges.
   */
  async #syncScope(
    context: CallContext,
    scope: { readonly productId: Id<'Product'> } | { readonly sellerId: Id<'Seller'> },
  ): Promise<SyncCounts & { readonly offers: number }> {
    const { market } = context;
    const indexed = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          'productId' in scope
            ? await this.deps.documents.offerIdsOfProduct(market, scope.productId)
            : await this.deps.documents.offerIdsOfSeller(market, scope.sellerId),
        ),
      { readOnly: true },
    );
    if (!indexed.ok) throw new Error('search: the index read failed');
    const first = await syncOffers(this.deps, context, indexed.value);
    let offers = indexed.value.length;
    let upserted = first.upserted;
    let deleted = first.deleted;
    let after: Id<'Offer'> | undefined;
    for (let page = 0; page < MAX_PRODUCT_PAGES; page += 1) {
      const ids = await this.deps.feed.publishedIds(context, {
        ...scope,
        ...(after === undefined ? {} : { after }),
        limit: SYNC_BATCH,
      });
      if (ids === null) throw new Error('search: catalog ids unavailable');
      const counts = await syncOffers(this.deps, context, ids);
      offers += ids.length;
      upserted += counts.upserted;
      deleted += counts.deleted;
      if (ids.length < SYNC_BATCH) return { offers, upserted, deleted };
      after = ids[ids.length - 1];
    }
    // Never a silently partial sync: the delivery is retried and, after its last attempt,
    // dead-lettered with an alert.
    throw new Error('search: too many Offers in one scope');
  }
}

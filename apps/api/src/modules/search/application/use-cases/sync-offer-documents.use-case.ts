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
  | { readonly sellerId: Id<'Seller'> };

/** The most pages of one product's or seller's Offers read in one call (a safety stop). */
const MAX_PRODUCT_PAGES = 50;

/**
 * `search.sync-offer-documents`: the handler of the catalog event subscriptions (offer
 * published, deleted or moved; product revision published) and of identity's seller access
 * suspended and reinstated. Rule `system`; the Market comes from
 * the envelope (the context). The event only says which Offers to look at: the content is
 * re-read from catalog, so deliveries may repeat and arrive in any order. Logs ids and counts.
 */
export class SyncOfferDocuments extends UseCase<SyncOfferDocumentsInput, SyncCounts, never> {
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
  ): Promise<Result<SyncCounts, never>> {
    const offerIds = 'offerIds' in input ? input.offerIds : await this.#offersOf(context, input);
    const counts = await syncOffers(this.deps, context, offerIds);
    this.#logger.log({
      msg: 'search.documents-synced',
      offers: offerIds.length,
      ...counts,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(counts);
  }

  /** The product's or seller's published Offers (from catalog) and those that have a document. */
  async #offersOf(
    context: CallContext,
    scope: { readonly productId: Id<'Product'> } | { readonly sellerId: Id<'Seller'> },
  ): Promise<Id<'Offer'>[]> {
    const { market } = context;
    const found = new Set<Id<'Offer'>>();
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
    for (const offerId of indexed.value) found.add(offerId);
    let after: Id<'Offer'> | undefined;
    for (let page = 0; page < MAX_PRODUCT_PAGES; page += 1) {
      const ids = await this.deps.feed.publishedIds(context, {
        ...scope,
        ...(after === undefined ? {} : { after }),
        limit: SYNC_BATCH,
      });
      if (ids === null) throw new Error('search: catalog ids unavailable');
      for (const offerId of ids) found.add(offerId);
      if (ids.length < SYNC_BATCH) return [...found];
      after = ids[ids.length - 1];
    }
    // Never a silently partial sync: the delivery is retried and, after its last attempt,
    // dead-lettered with an alert.
    throw new Error('search: too many Offers in one scope');
  }
}

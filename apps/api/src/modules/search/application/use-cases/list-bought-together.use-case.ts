import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  BOUGHT_TOGETHER_DEPTH,
  parseBoughtTogetherQuery,
  type BoughtTogetherRequest,
} from '../../domain/shelf-query';
import type { ShelfDependencies } from '../shelf-dependencies';
import { withPrimaryImages } from '../product-images';
import { itemOf, type ShelfFailure, type ShelfPage } from './list-bestsellers.use-case';

/**
 * `search.list-bought-together`: the Offers most often bought on the same paid order as one Offer
 * (the product page's shelf). Rule `anonymous`: no session, the request's Market, nothing about
 * the shopper. Ordering gives the partner Offer ids in rank order (3 or more distinct paid orders
 * over 90 days); the asked Offer itself is dropped, the rest that are indexed keep that order and
 * every one, and the asked Offer too (not shown: an empty shelf), is re-checked with catalog and sellers before it is shown. A source or check that
 * cannot be made is `search.unavailable`, never an unchecked list. A short or empty shelf is not
 * filled. Same item shape as the other shelves.
 */
export class ListBoughtTogether extends UseCase<BoughtTogetherRequest, ShelfPage, ShelfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-bought-together',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BoughtTogetherRequest,
  ): Promise<Result<ShelfPage, ShelfFailure>> {
    const query = parseBoughtTogetherQuery(input);
    if (!query.ok) return query;
    const { offerId, limit } = query.value;
    const { market } = context;

    const partners = await this.deps.sources.boughtTogetherOfferIds(
      context,
      offerId,
      BOUGHT_TOGETHER_DEPTH,
    );
    if (partners === null) return err({ code: 'search.unavailable' });
    const ranked = partners.filter((partner) => partner !== offerId);
    if (ranked.length === 0) return ok({ items: [] });

    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.shelves.byOfferIds(market, [offerId, ...ranked])),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'search.unavailable' });

    const byId = new Map(read.value.map((hit) => [hit.offerId, hit] as const));
    const asked = byId.get(offerId);
    // The asked Offer is re-checked too: a shelf under an Offer that is not shown is not shown.
    if (asked === undefined) return ok({ items: [] });
    const candidates = ranked.flatMap((id) => {
      const hit = byId.get(id);
      return hit === undefined ? [] : [hit];
    });
    const visible = await this.deps.visibility.visible(context, [asked, ...candidates]);
    if (visible === null) return err({ code: 'search.unavailable' });
    if (!visible.has(offerId)) return ok({ items: [] });
    const items = await withPrimaryImages(
      this.deps.images,
      context,
      candidates
        .filter((hit) => visible.has(hit.offerId))
        .slice(0, limit)
        .map(itemOf),
    );
    return ok({ items });
  }
}

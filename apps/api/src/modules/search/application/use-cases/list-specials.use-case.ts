import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseShelfQuery, type ShelfRequest } from '../../domain/shelf-query';
import type { ShelfSpecial } from '../ports/shelf-sources';
import type { ShelfDependencies } from '../shelf-dependencies';
import { withPrimaryImages } from '../product-images';
import { itemOf, type ShelfFailure } from './list-bestsellers.use-case';
import type { ProductSearchItem } from './search-products.use-case';

/** How many specials are asked of pricing: twice a full shelf, so one read stays cheap (Hassan M1). */
export const SPECIALS_DEPTH = 48;

/** A shelf item on special: the search item plus the priced Variant, the special and the regular price. */
export interface SpecialItem extends ProductSearchItem {
  readonly variantId: Id<'Variant'>;
  readonly price: Money;
  readonly regularPrice: Money;
  readonly taxInclusive: boolean;
  readonly specialEndsAt: Temporal.Instant;
}

export interface SpecialsPage {
  readonly items: readonly SpecialItem[];
}

/**
 * `search.list-specials`: the storefront's specials shelf. Rule `anonymous`: no session, the
 * request's Market. Pricing answers the (Offer, Variant) keys whose effective price is a special
 * at its Clock's now, newest first, with the regular price beside it. A key whose Variant is not
 * a published sell unit is dropped (Hassan L1); an Offer appears once (its first remaining key).
 * Only indexed Offers (in the category, when one is asked) that catalog and sellers
 * still show are kept. A source or check that cannot be made is `search.unavailable`. Prices are
 * always Money (amount and currency); never Cost.
 */
export class ListSpecials extends UseCase<ShelfRequest, SpecialsPage, ShelfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-specials',
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
    input: ShelfRequest,
  ): Promise<Result<SpecialsPage, ShelfFailure>> {
    const query = parseShelfQuery(input);
    if (!query.ok) return query;
    const { categoryId, limit } = query.value;
    const { market } = context;

    const specials = await this.deps.sources.specials(context, SPECIALS_DEPTH);
    if (specials === null) return err({ code: 'search.unavailable' });
    const published = await this.deps.variants.published(context, [
      ...new Set(specials.map((special) => special.offerId)),
    ]);
    if (published === null) return err({ code: 'search.unavailable' });
    const firstOf = new Map<Id<'Offer'>, ShelfSpecial>();
    for (const special of specials) {
      if (firstOf.has(special.offerId)) continue;
      if (published.get(special.offerId)?.has(special.variantId) !== true) continue;
      firstOf.set(special.offerId, special);
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.shelves.byOfferIds(market, [...firstOf.keys()])),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'search.unavailable' });
    const byId = new Map(read.value.map((hit) => [hit.offerId, hit] as const));
    const candidates = [...firstOf.keys()].flatMap((offerId) => {
      const hit = byId.get(offerId);
      return hit !== undefined && (categoryId === null || hit.categoryIds.includes(categoryId))
        ? [hit]
        : [];
    });
    const visible = await this.deps.visibility.visible(context, candidates);
    if (visible === null) return err({ code: 'search.unavailable' });
    const shown = candidates.filter((hit) => visible.has(hit.offerId)).slice(0, limit);
    const withSpecials = shown.map((hit) => {
      const special = firstOf.get(hit.offerId) as ShelfSpecial;
      return {
        ...itemOf(hit),
        variantId: special.variantId,
        price: special.price,
        regularPrice: special.regularPrice,
        taxInclusive: special.taxInclusive,
        specialEndsAt: special.endsAt,
      };
    });
    const items = await withPrimaryImages(this.deps.images, context, withSpecials);
    return ok({ items });
  }
}

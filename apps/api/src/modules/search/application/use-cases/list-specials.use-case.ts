import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseShelfQuery, type ShelfRequest } from '../../domain/shelf-query';
import type { ShelfSpecial } from '../ports/shelf-sources';
import type { SpecialsDependencies } from '../specials-dependencies';
import { withPrimaryImages } from '../product-images';
import { inAnyOf, itemOf, type ShelfFailure } from './list-bestsellers.use-case';
import type { ProductSearchItem } from './search-products.use-case';

/** How many specials are asked of pricing: twice a full shelf, so one read stays cheap (Hassan M1). */
export const SPECIALS_DEPTH = 48;

/**
 * A shelf item on special: the search item plus the priced Variant, the special and, only when the
 * Market's was-price rule allows it, the regular price to show struck through (otherwise null).
 */
export interface SpecialItem extends ProductSearchItem {
  readonly variantId: Id<'Variant'>;
  readonly price: Money;
  readonly regularPrice: Money | null;
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
 * Only indexed Offers (in the category or a subcategory, when one is asked) that catalog and sellers
 * still show are kept. A source or check that cannot be made is `search.unavailable`. Prices are
 * always Money (amount and currency); never Cost.
 *
 * The regular price is a reference price ("was"): it is answered only when it is above the special,
 * in the same currency, and `promotions`' was-price rule says the unit sold at it long enough (AU:
 * 28 of the last 90 days). Otherwise it is null and the special is shown on its own; a rule that
 * cannot be checked is null too (fail closed), never `search.unavailable`.
 */
export class ListSpecials extends UseCase<ShelfRequest, SpecialsPage, ShelfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-specials',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SpecialsDependencies,
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

    const categoryIds =
      categoryId === null ? null : await this.deps.categories.subtreeOf(context, categoryId);
    if (categoryId !== null && categoryIds === null) return err({ code: 'search.unavailable' });
    const inCategory = inAnyOf(categoryIds);
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
      return hit !== undefined && inCategory(hit) ? [hit] : [];
    });
    const visible = await this.deps.visibility.visible(context, candidates);
    if (visible === null) return err({ code: 'search.unavailable' });
    const shown = candidates.filter((hit) => visible.has(hit.offerId)).slice(0, limit);
    const withSpecials = await Promise.all(
      shown.map(async (hit) => {
        const special = firstOf.get(hit.offerId) as ShelfSpecial;
        return {
          ...itemOf(hit),
          variantId: special.variantId,
          price: special.price,
          regularPrice: await this.wasPriceOf(context, special),
          taxInclusive: special.taxInclusive,
          specialEndsAt: special.endsAt,
        };
      }),
    );
    const items = await withPrimaryImages(this.deps.images, context, withSpecials);
    return ok({ items });
  }

  /** The regular price to show struck through beside the special, or null (see the class note). */
  private async wasPriceOf(context: CallContext, special: ShelfSpecial): Promise<Money | null> {
    const { price, regularPrice } = special;
    if (regularPrice.currency !== price.currency || regularPrice.amount <= price.amount) {
      return null;
    }
    const unit = { offerId: special.offerId, variantId: special.variantId };
    try {
      return (await this.deps.wasPrice.eligible(context, unit, regularPrice)) ? regularPrice : null;
    } catch {
      // A rule that cannot be checked is not a yes: the special is shown on its own.
      return null;
    }
  }
}

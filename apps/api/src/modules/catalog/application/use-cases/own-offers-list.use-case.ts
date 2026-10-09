import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { offerViewOf, type OwnOfferView } from '../own-reads/own-offer-view';
import { parsePage, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnOffersListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface OwnOffersListOutput {
  readonly items: readonly OwnOfferView[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type OwnOffersListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnOffersListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-offers.list` (catalog design 8.2, 9.2a): the seller's own Offers that are not deleted,
 * newest first, keyset-paged, each with the label of its product. Rule: the key
 * `catalog.own-product.view` and the seller population; the seller comes from the actor. One
 * read-only unit (ADR-0025).
 */
export class OwnOffersList extends UseCase<
  OwnOffersListInput,
  OwnOffersListOutput,
  OwnOffersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offers-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOffersListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOffersListInput,
  ): Promise<Result<OwnOffersListOutput, OwnOffersListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const page = parsePage<'Offer'>(input);
    if (!page.ok) return page;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const rows = await this.deps.ownReader.listOffers(market, sellerId, {
          afterId: page.value.afterId,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const labels = await this.deps.ownReader.productLabels(
          market,
          [...new Set(shown.map((offer) => offer.state.productId))],
          locale,
        );
        return ok({ rows, shown, labels });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, labels } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    return ok({
      items: shown.map((offer) => offerViewOf(offer, labelOf.get(offer.state.productId))),
      nextAfterId: rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
    });
  }
}

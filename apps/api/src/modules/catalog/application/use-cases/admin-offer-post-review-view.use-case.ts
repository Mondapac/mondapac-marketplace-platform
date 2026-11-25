import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PermissionProbe } from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  postReviewKeys,
  postReviewRows,
  readPostReviewRowFacts,
  type AdminOfferPostReviewRow,
} from '../offer-post-review/post-review-rows';
import type { ValidationFailure } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';

export interface AdminOfferPostReviewViewOutput extends AdminOfferPostReviewRow {
  /** The decision note; only for a caller holding the approve key, else null. Never logged. */
  readonly note: string | null;
}

export type AdminOfferPostReviewViewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'post-review.not-found' }
  | ValidationFailure;

export interface AdminOfferPostReviewViewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly postReviews: OfferPostReviewRepository;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly productApproveProbe: PermissionProbe;
  readonly deleteProbe: PermissionProbe;
}

/**
 * `catalog.admin-offer-post-review-view` (risk-based Offer approval slice 6): one row of the
 * post-publication list in any status, as the list shows it, plus the decision note for a caller
 * who holds `catalog.product.approve`. Another Market's row is `post-review.not-found`. Rule:
 * `catalog.product.view` and the admin population; one read-only unit.
 */
export class AdminOfferPostReviewView extends UseCase<
  { readonly id: string },
  AdminOfferPostReviewViewOutput,
  AdminOfferPostReviewViewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-post-review-view',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewViewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly id: string },
  ): Promise<Result<AdminOfferPostReviewViewOutput, AdminOfferPostReviewViewFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = typeof input?.id === 'string' ? parseId<'OfferPostReview'>(input.id) : null;
    if (id === null || !id.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'id', code: 'format' }] });
    }
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const review = await deps.postReviews.findById(market, id.value);
        if (review === null) return ok(null);
        return ok({ review, facts: await readPostReviewRowFacts(deps, market, [review], locale) });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'post-review.not-found' });
    const { review, facts } = read.value;
    const keys = await postReviewKeys(deps, context);
    const [row] = await postReviewRows(deps, context, [review], facts, keys);
    if (row === undefined) return err({ code: 'access.unavailable' });
    return ok({ ...row, note: keys.approve ? review.state.note : null });
  }
}

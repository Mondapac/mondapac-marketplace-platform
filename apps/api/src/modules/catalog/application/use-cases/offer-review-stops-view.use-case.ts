import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CategoryOfferReviewFlagsStore } from '../ports/category-offer-review-flags.store';
import type { OfferReviewStopsReader } from '../ports/offer-review-stops.reader';

/** The active Offer review stops of the Market (the admin stop banner, slice 5). */
export interface OfferReviewStopsOutput {
  /** The Market's emergency stop (R0); null when settings cannot be read. */
  readonly marketStop: boolean | null;
  /**
   * Sellers with their review stop on; null when the caller lacks `sellers.seller.view` or
   * `sellers` cannot answer.
   */
  readonly stoppedSellers: number | null;
  /** Platform categories with their review stop on; null when they cannot be read. */
  readonly stoppedCategories: number | null;
  /** True when any stop that could be read is on: the banner shows. */
  readonly active: boolean;
}

export type OfferReviewStopsFailure = { readonly code: 'access.denied' };

export interface OfferReviewStopsViewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryFlags: CategoryOfferReviewFlagsStore;
  readonly stops: OfferReviewStopsReader;
}

/**
 * `offer-review.stops-view` (risk-based Offer approval slice 5): one cheap read for the admin stop
 * banner of every admin page: whether the Market's emergency stop is on, and how many sellers and
 * categories have their review stop on. Counts only, never which. Each part that cannot be read is
 * null (the banner leaves it out and never blocks); the seller count follows `sellers`' own rule
 * (`sellers.seller.view`). Rule: `catalog.product.view` and the admin population. The category
 * count is one read-only unit (ADR-0025) over the tiny flags table; the two facade reads follow.
 */
export class OfferReviewStopsView extends UseCase<
  Record<string, never>,
  OfferReviewStopsOutput,
  OfferReviewStopsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-review-stops-view',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferReviewStopsViewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OfferReviewStopsOutput, OfferReviewStopsFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    let stoppedCategories: number | null = null;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.categoryFlags.listFlagged(market)),
        { readOnly: true },
      );
      if (read.ok) stoppedCategories = read.value.filter((row) => row.reviewStop).length;
    } catch {
      stoppedCategories = null;
    }
    const [marketStop, stoppedSellers] = await Promise.all([
      this.deps.stops.marketStop(context),
      this.deps.stops.stoppedSellerCount(context),
    ]);
    return ok({
      marketStop,
      stoppedSellers,
      stoppedCategories,
      active: marketStop === true || (stoppedSellers ?? 0) > 0 || (stoppedCategories ?? 0) > 0,
    });
  }
}

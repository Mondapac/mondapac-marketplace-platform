import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { OfferReviewFlagsRepository } from '../ports/offer-review-flags.repository';

export type OfferReviewStoppedSellersFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface OfferReviewStoppedSellersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offerReviewFlags: OfferReviewFlagsRepository;
}

/**
 * `offerReviewStoppedSellerCount` (SEL-25; risk-based Offer approval slice 5): how many sellers of
 * the caller's Market have their Offer review stop on, for the admin stop banner. A count only,
 * never which sellers. Rule `permissions [sellers.seller.view]`, admin population only (the admin
 * who may see a seller's flags may see how many are stopped). One read-only unit; a read error is
 * `sellers.unavailable` (the banner then leaves the count out).
 */
export class OfferReviewStoppedSellers extends UseCase<
  Record<string, never>,
  number,
  OfferReviewStoppedSellersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.offer-review-stopped-sellers',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferReviewStoppedSellersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<number, OfferReviewStoppedSellersFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.offerReviewFlags.countStopped(market)),
        { readOnly: true },
      );
      return read.ok ? read : err({ code: 'sellers.unavailable' });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}

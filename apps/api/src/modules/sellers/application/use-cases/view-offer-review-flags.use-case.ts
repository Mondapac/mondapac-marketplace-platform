import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { OfferReviewFlagsRepository } from '../ports/offer-review-flags.repository';

export interface ViewOfferReviewFlagsInput {
  readonly sellerId?: unknown;
}

export interface OfferReviewFlagView {
  readonly on: boolean;
  /** When an admin last changed it; null when it never changed. */
  readonly changedAt: Temporal.Instant | null;
}

export interface ViewOfferReviewFlagsResult {
  readonly trustedFromStart: OfferReviewFlagView;
  readonly fullReview: OfferReviewFlagView;
  readonly reviewStop: OfferReviewFlagView;
  /** The admin settings row's version: the `expectedVersion` of the next change. */
  readonly version: number;
}

export type ViewOfferReviewFlagsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'file.not-found' };

export interface ViewOfferReviewFlagsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offerReviewFlags: OfferReviewFlagsRepository;
}

/**
 * `sellers.view-offer-review-flags` (SEL-25; risk-based Offer approval slice 4): the admin read of
 * a seller's three Offer review flags, when each last changed, and the row's version. Rule
 * `permissions [sellers.seller.view]`; admin population only. One read-only unit. An unknown
 * seller and another Market's seller are both `file.not-found`. Never a seller response.
 */
export class ViewOfferReviewFlagsUseCase extends UseCase<
  ViewOfferReviewFlagsInput,
  ViewOfferReviewFlagsResult,
  ViewOfferReviewFlagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.view-offer-review-flags',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOfferReviewFlagsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOfferReviewFlagsInput,
  ): Promise<Result<ViewOfferReviewFlagsResult, ViewOfferReviewFlagsFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const raw = (input ?? {}).sellerId;
    const seller = typeof raw === 'string' ? parseId<'Seller'>(raw) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    return this.deps.unitOfWork.run<ViewOfferReviewFlagsResult, ViewOfferReviewFlagsFailure>(
      market,
      async () => {
        const state = await this.deps.offerReviewFlags.read(market, sellerId);
        if (state === null) return err({ code: 'file.not-found' });
        const view = (flag: { on: boolean; changedAt: Temporal.Instant | null }) => ({
          on: flag.on,
          changedAt: flag.changedAt,
        });
        return ok({
          trustedFromStart: view(state.trustedFromStart),
          fullReview: view(state.fullReview),
          reviewStop: view(state.reviewStop),
          version: state.version,
        });
      },
      { readOnly: true },
    );
  }
}

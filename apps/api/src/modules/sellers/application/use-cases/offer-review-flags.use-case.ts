import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sellerActorOf } from '../draft/draft-support';
import type { OfferReviewFlagsRepository } from '../ports/offer-review-flags.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface OfferReviewFlagsInput {
  readonly sellerId: string;
}

/** One flag as the facade answers it: on, and when an admin last changed it. */
export interface OfferReviewFlagOf {
  readonly on: boolean;
  readonly at: Temporal.Instant | null;
}

/** `offerReviewFlagsOf`: the seller's three Offer review flags (SEL-25, slice 4). */
export interface OfferReviewFlagsOf {
  readonly trustedFromStart: OfferReviewFlagOf;
  readonly fullReview: OfferReviewFlagOf;
  readonly reviewStop: OfferReviewFlagOf;
}

export type OfferReviewFlagsFailure =
  SellerIdsRefused | { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface OfferReviewFlagsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offerReviewFlags: OfferReviewFlagsRepository;
}

/**
 * `offerReviewFlagsOf` (SEL-25; risk-based Offer approval slice 4), the one query function behind
 * both use cases of the pair: the seller's three Offer review flags in one read-only unit, each
 * with the time it last changed. A missing row (an unknown seller, another Market's seller) or a
 * read error is `sellers.unavailable`; catalog then fails closed (probation, full review).
 */
export async function offerReviewFlagsFor(
  deps: OfferReviewFlagsDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<OfferReviewFlagsOf, OfferReviewFlagsFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.offerReviewFlags.read(market, id)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'sellers.unavailable' });
    const state = read.value;
    return ok({
      trustedFromStart: { on: state.trustedFromStart.on, at: state.trustedFromStart.changedAt },
      fullReview: { on: state.fullReview.on, at: state.fullReview.changedAt },
      reviewStop: { on: state.reviewStop.on, at: state.reviewStop.changedAt },
    });
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/**
 * `offerReviewFlagsOf` for request actors: rule `own-resources`. Answered to an admin (catalog's
 * review decisions and reads) and to a seller's own request actor for its own seller id only (the
 * seller's submit and edits, where catalog reads the facts); any other request actor, or a
 * seller asking about another seller, is `access.denied` before any read. The flags never reach
 * a seller response: catalog uses them in its decision only. Its pair is the `system` case.
 */
export class OfferReviewFlags extends UseCase<
  OfferReviewFlagsInput,
  OfferReviewFlagsOf,
  OfferReviewFlagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.offer-review-flags',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferReviewFlagsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferReviewFlagsInput,
  ): Promise<Result<OfferReviewFlagsOf, OfferReviewFlagsFailure>> {
    const { actor } = context;
    const admin = actor.kind === 'authenticated' && actor.population === 'admin';
    if (!admin) {
      const owner = sellerActorOf(context);
      if (owner === null || owner.sellerId !== input?.sellerId) {
        return Promise.resolve(err({ code: 'access.denied' }));
      }
    }
    return offerReviewFlagsFor(this.deps, context, input?.sellerId);
  }
}

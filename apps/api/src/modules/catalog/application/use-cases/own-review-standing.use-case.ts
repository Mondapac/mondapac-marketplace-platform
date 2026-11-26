import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { trustStatusOf } from '../../domain/seller-review-standing';
import type { OfferReviewInputs } from '../ports/offer-review';
import type { SellerOfferReviewFlagsReader } from '../ports/seller-offer-review-flags.reader';
import type { SellerReviewStandingRepository } from '../ports/seller-review-standing.repository';
import { sellerOf } from '../own-reads/own-reads.shared';

/**
 * What a seller may know of their own probation (slice 7): the progress bar and nothing else.
 * `restarted` says the target is the shorter one after a take-down. No epoch, no flags, no
 * Trusted source or date, no sampling fact: a seller never learns how long double sampling lasts.
 */
export interface OwnReviewStandingResult {
  readonly status: 'probation' | 'trusted';
  /** Offers counted in the current probation; 0 once Trusted. */
  readonly count: number;
  /** Offers the probation needs; 0 once Trusted. */
  readonly target: number;
  readonly restarted: boolean;
}

export type OwnReviewStandingFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface OwnReviewStandingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly standings: SellerReviewStandingRepository;
  readonly sellerFlags: SellerOfferReviewFlagsReader;
  readonly reviewInputs: Pick<OfferReviewInputs, 'probationOffers'>;
}

/**
 * `catalog.own-review-standing` (risk-based Offer approval slice 7): the seller's own probation
 * progress, from the same `trustStatusOf` the policy uses. Rule: the key
 * `catalog.own-product.view` and the seller population; the seller comes from the actor. A failed
 * read of the standing or of the flags is `access.unavailable`, never a guessed status (the panel
 * then shows no bar).
 */
export class OwnReviewStanding extends UseCase<
  Record<string, never>,
  OwnReviewStandingResult,
  OwnReviewStandingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-review-standing',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnReviewStandingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnReviewStandingResult, OwnReviewStandingFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    let probationOffers: number;
    let flags;
    try {
      [probationOffers, flags] = await Promise.all([
        deps.reviewInputs.probationOffers(context),
        deps.sellerFlags.flagsOf(context, sellerId),
      ]);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // Sellers could not answer: no bar rather than a misleading "0 of N" for a Trusted seller
    // (Sajad B6), as when the read throws.
    if (flags === null) return err({ code: 'access.unavailable' });
    const trustedFromStart = flags.trustedFromStart;
    let read;
    try {
      read = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.standings.read(market, sellerId)),
        { readOnly: true },
      );
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!read.ok) return err({ code: 'access.unavailable' });
    const standing = read.value;
    const status = trustStatusOf(
      standing === null ? null : { ...standing.state, count: standing.count },
      { trustedFromStart },
      probationOffers,
    );
    const trusted = status.status === 'trusted';
    return ok({
      status: status.status,
      count: trusted ? 0 : status.count,
      target: trusted ? 0 : status.target,
      restarted: !trusted && (standing?.state.targetKind ?? 'initial') === 'after-misconduct',
    });
  }
}

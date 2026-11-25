import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../../sellers';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import {
  trustStatusOf,
  type StandingTargetKind,
  type TrustStatus,
} from '../../domain/seller-review-standing';
import type { OfferReviewInputs } from '../ports/offer-review';
import type {
  SellerOfferReviewFlags,
  SellerOfferReviewFlagsReader,
} from '../ports/seller-offer-review-flags.reader';
import type { SellerReviewStandingRepository } from '../ports/seller-review-standing.repository';

export interface ViewSellerReviewStandingInput {
  readonly sellerId?: unknown;
}

export interface ViewSellerReviewStandingResult extends TrustStatus {
  /** N read now (the safe 100 when it cannot be read). */
  readonly probationOffers: number;
  /** 0 while the seller has no standing yet (nothing approved or sent back). */
  readonly epoch: number;
  readonly targetKind: StandingTargetKind;
  readonly consecutiveChangesNeeded: number;
  readonly trustLostAt: Temporal.Instant | null;
  /** The seller's Offer review flags (SEL-25); null when sellers could not answer. */
  readonly flags: SellerOfferReviewFlags | null;
}

export type ViewSellerReviewStandingFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-found' };

export interface ViewSellerReviewStandingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly standings: SellerReviewStandingRepository;
  readonly sellerFlags: SellerOfferReviewFlagsReader;
  readonly reviewInputs: Pick<OfferReviewInputs, 'probationOffers'>;
}

/**
 * `catalog.view-seller-review-standing` (risk-based Offer approval slice 4): the admin read of a
 * seller's probation and Trusted, as the policy sees it now (`trustStatusOf` with N read now and
 * the seller's flags), with the stored epoch, target kind and the last misconduct revocation.
 * Rule `permissions [catalog.product.approve, sellers.seller.view]`; admin population only. A seller with no standing
 * yet answers count 0 and epoch 0. The seller's flags come from `sellers.offerReviewFlagsOf`; when
 * sellers cannot answer, `flags` is null and Trusted from start is read as off (the stricter
 * answer). A malformed id is `seller.not-found`; a failed read of the standing is
 * `access.unavailable`, never a guessed status.
 */
export class ViewSellerReviewStanding extends UseCase<
  ViewSellerReviewStandingInput,
  ViewSellerReviewStandingResult,
  ViewSellerReviewStandingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.view-seller-review-standing',
    // The seller's review flags are shown here too, so the sellers read key is required as well
    // (Hassan N2 on PR #1358): nobody sees them here who cannot read them in sellers.
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key, SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewSellerReviewStandingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewSellerReviewStandingInput,
  ): Promise<Result<ViewSellerReviewStandingResult, ViewSellerReviewStandingFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const raw = (input ?? {}).sellerId;
    const parsed = typeof raw === 'string' ? parseId<'Seller'>(raw) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'seller.not-found' });
    const sellerId = parsed.value;
    const { deps } = this;
    const [probationOffers, flags] = await Promise.all([
      deps.reviewInputs.probationOffers(context),
      deps.sellerFlags.flagsOf(context, sellerId).catch(() => null),
    ]);
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
      { trustedFromStart: flags?.trustedFromStart ?? { on: false, at: null } },
      probationOffers,
    );
    return ok({
      ...status,
      probationOffers,
      epoch: standing?.state.epoch ?? 0,
      targetKind: standing?.state.targetKind ?? 'initial',
      consecutiveChangesNeeded: standing?.state.consecutiveChangesNeeded ?? 0,
      trustLostAt: standing?.state.trustLostAt ?? null,
      flags,
    });
  }
}

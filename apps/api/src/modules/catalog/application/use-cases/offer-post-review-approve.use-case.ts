import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OfferPostReviewApprovedAudit } from '../../domain/audit';
import {
  decidesOwnPostReview,
  parsePostReviewDecision,
  type OfferPostReviewDecided,
  type OfferPostReviewDecisionFailure,
} from '../offer-post-review/post-review-decision';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';

export interface AdminOfferPostReviewApproveInput {
  readonly id: string;
  readonly version: unknown;
  /** Optional, 1 to 2000 characters. Never logged or audited. */
  readonly note?: unknown;
}

export interface AdminOfferPostReviewApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly postReviews: OfferPostReviewRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `catalog.offer-post-review-approve` (risk-based Offer approval slice 6): an admin closes an open
 * row of the post-publication review list; the Offer stays as it is (it may not be live any more:
 * Approve still closes the row). Rule: `catalog.product.approve` and the admin population;
 * refused in any Login-as-Seller session (`access.denied`), as the take-down. The row must be
 * open (`post-review.not-open`) at the version the admin saw (`conflict.stale`); an admin behind
 * one of the Offer's submits is `post-review.own-submission`. One unit: the conditional update on the version, then the audit
 * row (the note is never audited or logged).
 */
export class AdminOfferPostReviewApprove extends UseCase<
  AdminOfferPostReviewApproveInput,
  OfferPostReviewDecided,
  OfferPostReviewDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-post-review-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('AdminOfferPostReviewApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferPostReviewApproveInput,
  ): Promise<Result<OfferPostReviewDecided, OfferPostReviewDecisionFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.offer-post-review-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: AdminOfferPostReviewApproveInput,
  ): Promise<Result<OfferPostReviewDecided, OfferPostReviewDecisionFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    // Never from a Login-as-Seller session, whoever it acts for, as the take-down (Hassan N2).
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const parsed = parsePostReviewDecision(input, 'optional');
    if (!parsed.ok) return parsed;
    const { id, version, note } = parsed.value;
    const { deps } = this;
    const written = await deps.unitOfWork.run<
      OfferPostReviewDecided,
      OfferPostReviewDecisionFailure
    >(market, async () => {
      const review = await deps.postReviews.findById(market, id);
      if (review === null) return err({ code: 'post-review.not-found' } as const);
      if (review.state.status !== 'open') return err({ code: 'post-review.not-open' } as const);
      if (review.state.version !== version) return err({ code: 'conflict.stale' } as const);
      const submitters = await deps.postReviews.submitterAccountIds(market, review.state.offerId);
      if (decidesOwnPostReview(actor, review.state.sellerId, submitters)) {
        return err({ code: 'post-review.own-submission' } as const);
      }
      const approved = review.approve({ accountId: actor.accountId, note, now: deps.clock.now() });
      if (!approved.ok) {
        return approved.error.code === 'post-review.not-open'
          ? err({ code: 'post-review.not-open' } as const)
          : err({
              code: 'validation.failed',
              fields: [{ path: 'note', code: 'invalid' }],
            } as const);
      }
      if (!(await deps.postReviews.save(market, review))) {
        return err({ code: 'conflict.stale' } as const);
      }
      await deps.audit.record(
        context,
        OfferPostReviewApprovedAudit.entry(review.state.offerId, {
          after: { postReviewId: review.state.id },
        }),
      );
      return ok({
        id: review.state.id,
        offerId: review.state.offerId,
        status: 'approved' as const,
        version: review.state.version,
      });
    });
    return written;
  }
}

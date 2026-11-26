import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE, CATALOG_PRODUCT_DELETE } from '../../contracts/permissions';
import { OfferTakenDownAudit } from '../../domain/audit';
import { isActingAsSession } from '../acting-as';
import type { OfferEditReview } from '../offer-edit-review';
import {
  decidesOwnPostReview,
  parsePostReviewDecision,
  parseTakeDownReason,
  type OfferPostReviewDecided,
  type OfferPostReviewDecisionFailure,
} from '../offer-post-review/post-review-decision';
import type { OfferPendingChangeRepository } from '../ports/offer-pending-change.repository';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerReviewProbation } from '../seller-review-probation';

export interface AdminOfferPostReviewTakeDownInput {
  readonly id: string;
  readonly version: unknown;
  /** One of the Offer change reasons. */
  readonly reasonCode: unknown;
  /** True revokes the seller's Trusted in the same unit. */
  readonly misconduct: unknown;
  /** Required, 1 to 2000 characters. Never logged or audited. */
  readonly note: unknown;
}

export interface AdminOfferPostReviewTakeDownDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly postReviews: OfferPostReviewRepository;
  readonly offers: OfferRepository;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly editReview: Pick<OfferEditReview, 'supersede'>;
  readonly probation: Pick<SellerReviewProbation, 'revokeForMisconduct'>;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `catalog.offer-post-review-take-down` (risk-based Offer approval slice 6): an admin takes a
 * published Offer off sale after publication. Rule: `catalog.product.approve` and
 * `catalog.product.delete`, the admin population; refused in a Login-as-Seller session
 * (`access.denied`). Closed body `{ version, reasonCode, misconduct, note }`.
 *
 * In one unit (the Offer row is locked first; the rest are serialized by it):
 * the row must be open (`post-review.not-open`) at the version seen (`conflict.stale`); the Offer
 * must be `published` (`offer.not-live`; Approve still closes such a row); an admin behind one of
 * the Offer's submits is `post-review.own-submission`. The Offer goes `changes-needed` (no longer
 * listed: open carts answer `offer-unavailable`, checkout refuses it, placed orders are untouched)
 * with `catalog.offer-changes-requested.v1` (the seller's notice) and
 * `catalog.offer-listing-changed.v1`; its held edit, if any, is superseded (`taken-down`);
 * `misconduct` revokes Trusted (a seller with no standing gets one started, then revoked); the row
 * is `taken-down`; `catalog.offer.taken-down` is audited with codes only.
 */
export class AdminOfferPostReviewTakeDown extends UseCase<
  AdminOfferPostReviewTakeDownInput,
  OfferPostReviewDecided,
  OfferPostReviewDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-post-review-take-down',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PRODUCT_APPROVE.key, CATALOG_PRODUCT_DELETE.key],
    },
  };

  readonly #logger = new Logger('AdminOfferPostReviewTakeDown');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewTakeDownDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferPostReviewTakeDownInput,
  ): Promise<Result<OfferPostReviewDecided, OfferPostReviewDecisionFailure>> {
    const result = await this.#takeDown(context, input);
    this.#logger.log({
      msg: 'catalog.offer-post-review-take-down',
      code: result.ok ? 'taken-down' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #takeDown(
    context: CallContext,
    input: AdminOfferPostReviewTakeDownInput,
  ): Promise<Result<OfferPostReviewDecided, OfferPostReviewDecisionFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    // Never from a Login-as-Seller session (whoever it acts for).
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const parsed = parsePostReviewDecision(input, 'required', ['reasonCode', 'misconduct']);
    if (!parsed.ok) return parsed;
    const { id, version, note, raw } = parsed.value;
    const reasonCode = parseTakeDownReason(raw['reasonCode']);
    if (!reasonCode.ok) return reasonCode;
    const misconduct = raw['misconduct'];
    if (typeof misconduct !== 'boolean') {
      return err({ code: 'validation.failed', fields: [{ path: 'misconduct', code: 'type' }] });
    }
    if (note === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] });
    }
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<OfferPostReviewDecided, OfferPostReviewDecisionFailure>(
        market,
        async () => {
          // The row is read first, unlocked: it names the Offer, so the Offer cannot be read
          // before it. Nothing is locked by these reads (READ COMMITTED). The first lock is the
          // Offer row's conditional update below; the row's own conditional update on the
          // version read follows it, so a row decided or extended meanwhile is `conflict.stale`
          // and the whole unit rolls back (Sajad 5).
          const review = await deps.postReviews.findById(market, id);
          if (review === null) return err({ code: 'post-review.not-found' } as const);
          if (review.state.status !== 'open') {
            return err({ code: 'post-review.not-open' } as const);
          }
          if (review.state.version !== version) return err({ code: 'conflict.stale' } as const);
          const offer = await deps.offers.findById(market, review.state.offerId);
          if (
            offer === null ||
            offer.state.sellerId !== review.state.sellerId ||
            offer.state.status !== 'published'
          ) {
            return err({ code: 'offer.not-live' } as const);
          }
          const submitters = await deps.postReviews.submitterAccountIds(market, offer.state.id);
          if (decidesOwnPostReview(actor, review.state.sellerId, submitters)) {
            return err({ code: 'post-review.own-submission' } as const);
          }
          const now = deps.clock.now();
          const down = offer.takeDown({ reasonCode: reasonCode.value, now });
          if (!down.ok) return err({ code: 'offer.not-live' } as const);
          // Lock order: the Offer row first (its version check); after it the order of the rest
          // (the row, the held change, the standing) does not matter, as the Offer lock
          // serializes them (Mojtaba N1).
          await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
          const decided = review.takeDown({
            accountId: actor.accountId,
            reasonCode: reasonCode.value,
            misconduct,
            note,
            now,
          });
          if (!decided.ok) {
            return decided.error.code === 'post-review.not-open'
              ? err({ code: 'post-review.not-open' } as const)
              : err({
                  code: 'validation.failed',
                  fields: [{ path: 'note', code: 'invalid' }],
                } as const);
          }
          if (!(await deps.postReviews.save(market, review))) {
            throw new StaleAggregateError('offer-post-review', review.state.id);
          }
          const held = await deps.pendingChanges.findOpenByOffer(market, offer.state.id);
          if (held !== null) await deps.editReview.supersede(context, held, 'taken-down', now);
          if (misconduct) {
            await deps.probation.revokeForMisconduct(context, {
              sellerId: offer.state.sellerId,
              now,
            });
          }
          await deps.audit.record(
            context,
            OfferTakenDownAudit.entry(offer.state.id, {
              after: { postReviewId: review.state.id, reasonCode: reasonCode.value, misconduct },
            }),
          );
          await deps.outbox.append(context, offer.pendingEvents);
          return ok({
            id: review.state.id,
            offerId: offer.state.id,
            status: 'taken-down' as const,
            version: review.state.version,
          });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}

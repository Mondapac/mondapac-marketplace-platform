import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  PRICE_POST_REVIEW_REASONS,
  type PricePostReviewReferral,
} from '../../domain/offer-post-review';
import { receivePostReviewReason } from '../offer-post-review/post-review-intake';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';

export interface OfferPostReviewReferInput {
  readonly offerId: string;
  readonly sellerId: string;
  readonly reason: string;
  /** The pricing record the referral is about: the idempotency key with the Offer and reason. */
  readonly sourceRef: string;
}

/** What the referral did; every outcome is a success of the delivery. */
export interface OfferPostReviewReferOutput {
  readonly code:
    | 'post-review.opened'
    | 'post-review.extended'
    | 'post-review.unchanged'
    | 'post-review.duplicate'
    | 'post-review.offer-gone';
}

export type OfferPostReviewReferFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'conflict.retry' };

export interface OfferPostReviewReferDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly postReviews: OfferPostReviewRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lost race (another unit opened or changed the row first) is asked again this many times. */
const ATTEMPTS = 3;

/**
 * `catalog.offer-post-review-refer` (risk-based Offer approval slice 6): pricing's R4 check puts a
 * published Offer on the post-publication review list (`CatalogFacade.referOfferForPostReview`,
 * from pricing's subscriber of its own `pricing.offer-post-review-flagged.v1`). Rule `system`; the
 * Market is the delivery's. Idempotent on (Market, Offer, reason, source): a redelivery changes
 * nothing. An unknown or deleted Offer, another Market's, or a seller that is not the Offer's
 * answers ok with nothing written (a code in the log only). Codes only: no price or median ever
 * reaches catalog. A refusal makes the subscriber throw, so the delivery is retried (P 6.4).
 */
export class OfferPostReviewRefer extends UseCase<
  OfferPostReviewReferInput,
  OfferPostReviewReferOutput,
  OfferPostReviewReferFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-post-review-refer',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('OfferPostReviewRefer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferPostReviewReferDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferPostReviewReferInput,
  ): Promise<Result<OfferPostReviewReferOutput, OfferPostReviewReferFailure>> {
    const result = await this.#refer(context, input);
    this.#logger.log({
      msg: 'catalog.offer-post-review-refer',
      code: result.ok ? result.value.code : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #refer(
    context: CallContext,
    input: OfferPostReviewReferInput,
  ): Promise<Result<OfferPostReviewReferOutput, OfferPostReviewReferFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const offerId = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offerId === null || !offerId.ok) return invalid('offerId', 'format');
    const sellerId = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (sellerId === null || !sellerId.ok) return invalid('sellerId', 'format');
    const reason = PRICE_POST_REVIEW_REASONS.find((known) => known === input.reason);
    if (reason === undefined) return invalid('reason', 'value');
    if (typeof input.sourceRef !== 'string' || !UUID.test(input.sourceRef)) {
      return invalid('sourceRef', 'format');
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        return await this.#write(context, offerId.value, sellerId.value, reason, input.sourceRef);
      } catch (error) {
        if (!(error instanceof StaleAggregateError)) throw error;
      }
    }
    return err({ code: 'conflict.retry' });
  }

  async #write(
    context: CallContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    reason: PricePostReviewReferral,
    sourceRef: string,
  ): Promise<Result<OfferPostReviewReferOutput, OfferPostReviewReferFailure>> {
    const { market } = context;
    const { deps } = this;
    const written = await deps.unitOfWork.run<OfferPostReviewReferOutput, never>(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId);
        if (
          offer === null ||
          offer.state.status === 'deleted' ||
          offer.state.sellerId !== sellerId
        ) {
          return ok({ code: 'post-review.offer-gone' } as const);
        }
        const outcome = await receivePostReviewReason(deps, market, {
          offerId,
          sellerId,
          productId: offer.state.productId,
          reason,
          sourceRef,
          now: deps.clock.now(),
        });
        return ok({ code: `post-review.${outcome}` } as const);
      },
    );
    if (!written.ok) throw new Error('catalog.offer-post-review-refer: the unit failed');
    return ok(written.value);
  }
}

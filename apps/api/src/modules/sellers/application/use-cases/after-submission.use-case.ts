import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  REVIEWER_NOTICE_MARKET_LIMITS,
  REVIEWER_NOTICE_SELLER_LIMITS,
  rateVerdict,
  type RateLimit,
} from '../../domain/rate-limits';
import type { RevisionKind } from '../../domain/revision-kinds';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import type { ReviewerNotifier } from '../ports/reviewer-notifier';

/** One delivery of `sellers.business-file-submitted.v1` to `sellers.after-submission` (7.5). */
export interface AfterSubmissionInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id;
  readonly revisionId: Id;
  readonly kind: RevisionKind;
}

export type AfterSubmissionOutput =
  | { readonly code: 'after-submission.notified' }
  | { readonly code: 'after-submission.coalesced' }
  | { readonly code: 'after-submission.skipped' }
  | { readonly code: 'after-submission.already-handled' };

export type AfterSubmissionFailure = { readonly code: 'access.denied' };

export interface AfterSubmissionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly notifier: ReviewerNotifier;
  readonly clock: Clock;
}

interface Reservation {
  readonly counter: RateCounter;
  readonly windowStartedAt: Temporal.Instant;
  readonly allowed: boolean;
}

/**
 * The handler `sellers.after-submission` (sellers design 7.5; slice 5b). Rule `system`, from the
 * subscription on its own `sellers.business-file-submitted.v1`. For an `onboarding` revision that
 * is still pending it asks `identity` to tell the admins who may approve, coalesced (Ali R-3;
 * data design 3.11): the counter `reviewer-notice.seller` (1 per fixed 6 h window) is reserved in
 * a unit of its own, then `reviewer-notice.market` (1 per fixed 15 minutes) in another, only if the
 * first was due. A notice refused by either window is coalesced: both reservations are kept and
 * the delivery is marked handled. The reservations are kept only when `identity` answers `sent`;
 * on every other outcome each is released (a guarded decrement of the window it was taken in),
 * and an `unavailable` answer, an error or a timeout fails the delivery so it is retried. The
 * call to `identity` is made outside any unit. The automatic approval of 7.3 belongs to slice 7b:
 * until then every onboarding file waits for a person. The `identity-change` mail waits for its
 * slice. Nothing but ids and codes is logged.
 */
export class AfterSubmission extends UseCase<
  AfterSubmissionInput,
  AfterSubmissionOutput,
  AfterSubmissionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.after-submission',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('AfterSubmission');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AfterSubmissionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AfterSubmissionInput,
  ): Promise<Result<AfterSubmissionOutput, AfterSubmissionFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const output = await this.run(context, input);
    this.#logger.log({
      msg: `sellers.${output.code}`,
      sellerId: input.sellerId,
      revisionId: input.revisionId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  /** Marks the delivery handled in the inbox; false when it already was. */
  private async markHandled(context: CallContext, delivery: EventDelivery): Promise<boolean> {
    const handled = await this.deps.unitOfWork.runOnce(context.market, delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!handled.ok) throw new Error('after-submission: the unit failed');
    return handled.value.handled;
  }

  private async run(
    context: CallContext,
    input: AfterSubmissionInput,
  ): Promise<AfterSubmissionOutput> {
    const { market } = context;
    const sellerId = input.sellerId as Id<'Seller'>;
    const { unitOfWork, revisions, notifier } = this.deps;

    if (input.kind !== 'onboarding') {
      return (await this.markHandled(context, input.delivery))
        ? { code: 'after-submission.skipped' }
        : { code: 'after-submission.already-handled' };
    }
    const read = await unitOfWork.run(
      market,
      async () =>
        ok(
          await revisions.findById(
            market,
            sellerId,
            input.revisionId as Id<'BusinessFileRevision'>,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('after-submission: the read failed');
    if (read.value === null || read.value.status !== 'pending') {
      return (await this.markHandled(context, input.delivery))
        ? { code: 'after-submission.skipped' }
        : { code: 'after-submission.already-handled' };
    }

    // Seller window first, the Market window only if the first was due (data design 3.11).
    const bySeller = await this.reserve(context, REVIEWER_NOTICE_SELLER_LIMITS[0]!, sellerId);
    const reserved: Reservation[] = [bySeller];
    let coalesced = !bySeller.allowed;
    if (!coalesced) {
      let byMarket: Reservation;
      try {
        byMarket = await this.reserve(context, REVIEWER_NOTICE_MARKET_LIMITS[0]!, market.marketId);
      } catch (error) {
        // The seller window must not stay spent for a notice that was never tried.
        await this.releaseAll(context, reserved);
        throw error;
      }
      reserved.push(byMarket);
      coalesced = !byMarket.allowed;
    }
    if (coalesced) {
      // Both reservations stay: the notice is covered by an earlier one.
      return (await this.markHandled(context, input.delivery))
        ? { code: 'after-submission.coalesced' }
        : { code: 'after-submission.already-handled' };
    }

    let answer: 'sent' | 'skipped' | 'unavailable';
    try {
      answer = await notifier.notify(context, sellerId);
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.after-submission.notify-failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      answer = 'unavailable';
    }
    if (answer !== 'sent') await this.releaseAll(context, reserved);
    if (answer === 'unavailable') throw new Error('after-submission: the reviewers were not told');
    const first = await this.markHandled(context, input.delivery);
    if (!first) return { code: 'after-submission.already-handled' };
    return { code: answer === 'sent' ? 'after-submission.notified' : 'after-submission.skipped' };
  }

  /** Reserves one attempt on one counter in a unit of its own. A store that fails throws. */
  private async reserve(
    context: CallContext,
    limit: RateLimit,
    subject: string,
  ): Promise<Reservation> {
    const { market } = context;
    const counter: RateCounter = {
      limit,
      keyHash: this.deps.counterKeys.keyOf(market, limit.kind, subject),
    };
    const now = this.deps.clock.now();
    const reserved = await this.deps.unitOfWork.run(market, async () =>
      ok(await this.deps.counters.reserve(market, [counter], now)),
    );
    if (!reserved.ok) throw new Error('after-submission: the counter unit failed');
    const reservation = reserved.value[0];
    if (reservation === undefined) throw new Error('after-submission: no reservation');
    return {
      counter,
      windowStartedAt: reservation.windowStartedAt,
      allowed: rateVerdict([limit], reserved.value, now).allowed,
    };
  }

  /** Releases each reservation in a unit of its own; a failed release is logged, never thrown. */
  private async releaseAll(context: CallContext, reserved: readonly Reservation[]): Promise<void> {
    const { market } = context;
    for (const reservation of reserved) {
      try {
        await this.deps.unitOfWork.run(market, async () =>
          ok(
            await this.deps.counters.release(
              market,
              reservation.counter,
              reservation.windowStartedAt,
            ),
          ),
        );
      } catch (error) {
        this.#logger.error({
          msg: 'sellers.after-submission.release-failed',
          kind: reservation.counter.limit.kind,
          error: error instanceof Error ? error.name : 'unknown',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
  }
}

import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { retireSeries, type RetirementDependencies, type RetirementOutput } from '../retire-series';
import { runSerializableOnce } from '../serializable-unit';

/** One delivery of `catalog.offer-deleted.v1` (pricing design 6.4). */
export interface RetireSeriesForRemovedOfferInput {
  readonly delivery: EventDelivery;
  readonly offerId: Id<'Offer'>;
}

export type RetireSeriesFailure = { readonly code: 'access.denied' };

/**
 * The handler `pricing.retire-series-for-removed-offer` (pricing design 6.4, 9; slice 1, M5).
 * Rule `system`, from the subscription on `catalog.offer-deleted.v1`; the Market comes from the
 * envelope (the context). In one `serializable` unit opened through the inbox's `runOnce`: every
 * series of the Offer is retired (pending records superseded with cause `offer-removed`), the
 * permanent Offer tombstone is recorded even when no series exists, audit rows and events are
 * written. The write skew with a first price is closed by SERIALIZABLE on both: PostgreSQL
 * refuses one with `40001`, the UnitOfWork runs it again, and the retried creator sees the
 * tombstone. A second delivery stops at the inbox. Never in `catalog`'s transaction. Logs hold
 * ids, codes and counts only.
 */
export class RetireSeriesForRemovedOffer extends UseCase<
  RetireSeriesForRemovedOfferInput,
  RetirementOutput,
  RetireSeriesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.retire-series-for-removed-offer',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RetireSeriesForRemovedOffer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RetirementDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RetireSeriesForRemovedOfferInput,
  ): Promise<Result<RetirementOutput, RetireSeriesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { offerId, delivery } = input;

    const handled = await runSerializableOnce(this.deps.unitOfWork, market, delivery, () =>
      retireSeries(
        this.deps,
        context,
        'offer-removed',
        () => this.deps.series.findByOffer(market, offerId),
        (retiredAt) =>
          this.deps.tombstones.recordRetiredOffer(market, {
            offerId,
            retiredAt,
            causeEventId: delivery.eventId,
          }),
      ),
    );
    if (!handled.ok) throw new Error('pricing.retire-series-for-removed-offer: the unit failed');

    const output: RetirementOutput = handled.value.handled
      ? {
          code: 'pricing.series-retired',
          series: handled.value.value.series,
          superseded: handled.value.value.superseded,
        }
      : { code: 'pricing.retire.already-handled' };
    this.#logger.log({
      msg: output.code,
      offerId,
      ...(output.code === 'pricing.series-retired'
        ? { series: output.series, superseded: output.superseded }
        : {}),
      eventId: delivery.eventId,
      attempt: delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}

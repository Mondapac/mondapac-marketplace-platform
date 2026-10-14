import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { retireSeries, type RetirementDependencies, type RetirementOutput } from '../retire-series';
import { runSerializableOnce } from '../serializable-unit';
import type { RetireSeriesFailure } from './retire-series-for-removed-offer.use-case';

/** One delivery of `catalog.variant-removed.v1` (pricing design 6.4). */
export interface RetireSeriesForRemovedVariantInput {
  readonly delivery: EventDelivery;
  readonly productId: Id<'Product'>;
  readonly variantId: Id<'Variant'>;
}

/**
 * The handler `pricing.retire-series-for-removed-variant` (pricing design 6.4, 9; slice 1, M5).
 * Rule `system`, from the subscription on `catalog.variant-removed.v1`; the Market comes from the
 * envelope (the context). In one `serializable` unit opened through the inbox's `runOnce`: every
 * series of the (Product, Variant), across every Offer, is retired (pending records superseded
 * with cause `variant-removed`), the permanent (Product, Variant) tombstone is recorded even when no series exists, audit rows and events are
 * written. The write skew with a first price is closed by SERIALIZABLE on both: PostgreSQL
 * refuses one with `40001`, the UnitOfWork runs it again, and the retried creator sees the
 * tombstone. A second delivery stops at the inbox. Never in `catalog`'s transaction. Logs hold
 * ids, codes and counts only.
 */
export class RetireSeriesForRemovedVariant extends UseCase<
  RetireSeriesForRemovedVariantInput,
  RetirementOutput,
  RetireSeriesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.retire-series-for-removed-variant',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RetireSeriesForRemovedVariant');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RetirementDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RetireSeriesForRemovedVariantInput,
  ): Promise<Result<RetirementOutput, RetireSeriesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { productId, variantId, delivery } = input;

    const handled = await runSerializableOnce(this.deps.unitOfWork, market, delivery, () =>
      retireSeries(
        this.deps,
        context,
        'variant-removed',
        () => this.deps.series.findByProductVariant(market, productId, variantId),
        (retiredAt) =>
          this.deps.tombstones.recordRetiredVariant(market, {
            productId,
            variantId,
            retiredAt,
            causeEventId: delivery.eventId,
          }),
      ),
    );
    if (!handled.ok) throw new Error('pricing.retire-series-for-removed-variant: the unit failed');

    const output: RetirementOutput = handled.value.handled
      ? {
          code: 'pricing.series-retired',
          series: handled.value.value.series,
          superseded: handled.value.value.superseded,
        }
      : { code: 'pricing.retire.already-handled' };
    this.#logger.log({
      msg: output.code,
      productId,
      variantId,
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

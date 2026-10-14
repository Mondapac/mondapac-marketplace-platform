import type { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { PriceSeries } from '../domain/price-series';
import type { OfferSellUnitsSource } from './ports/offer-sell-units';
import type { PriceSeriesRepository } from './ports/price-series.repository';
import {
  recordOfferWriteRefusal,
  type OfferWriteRefusalDependencies,
} from './refusals/offer-write-refusal';
import { refusalCause } from './use-cases/set-regular-price.use-case';
import type { WriteAllowanceDependencies } from './write-allowance';

export interface SellerSeriesWriteDependencies
  extends OfferWriteRefusalDependencies, WriteAllowanceDependencies {
  readonly series: PriceSeriesRepository;
  readonly offers: OfferSellUnitsSource;
  readonly outbox: OutboxWriter;
}

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });
const STALE = Object.freeze({ code: 'conflict.stale' as const });

export type SellerSeriesWriteFailure = typeof NOT_FOUND | typeof STALE;

/**
 * The write of a seller's change to an existing price series, shared by the special-price use
 * cases (pricing design 5.2, 9). The caller has checked that the actor is a seller and its own
 * input. Order, as for the regular price:
 * 1. Ownership, before any unit: catalog's `offerSellUnits` through the port. Absent, not the
 *    actor's, deleted, or a Variant outside its sell units all answer the same
 *    `pricing.offer-not-found`, after the same refusal unit (the cause stays in the audit row).
 * 2. One READ COMMITTED unit: the series is loaded (none: `missingSeries`), its seller copy must
 *    be the seller catalog names (`not-yours` otherwise, the same refusal), the version the screen
 *    sent must be the stored one (`conflict.stale`), the change is applied in the aggregate,
 *    saved, audited and its events appended in the same unit. A series is never created here: a
 *    special price needs a regular price first.
 */
export async function sellerSeriesWrite<T, E extends { readonly code: string }>(
  deps: SellerSeriesWriteDependencies,
  context: CallContext,
  logger: Logger,
  write: {
    /** The authenticated seller actor, checked by the use case. */
    readonly accountId: Id<'Account'>;
    readonly sellerId: Id<'Seller'>;
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly expectedVersion: number;
    /** The answer when the Variant has no series yet. */
    readonly missingSeries: E;
    readonly apply: (series: PriceSeries, now: Temporal.Instant) => Result<T, E>;
    readonly audit: (series: PriceSeries, value: T) => Promise<void>;
  },
): Promise<
  Result<{ readonly value: T; readonly series: PriceSeries }, E | SellerSeriesWriteFailure>
> {
  const { market } = context;
  const { offerId, variantId, accountId } = write;
  const offers = await deps.offers.sellUnitsOf(context, [offerId]);
  const offer = offers.get(offerId) ?? null;
  const cause = refusalCause(offer, write.sellerId, variantId);
  if (cause !== null || offer === null) {
    return refuse(deps, context, logger, accountId, offerId, variantId, cause ?? 'absent');
  }

  const written = await deps.unitOfWork.run<
    { readonly value: T; readonly series: PriceSeries } | 'not-yours',
    E | typeof STALE
  >(market, async () => {
    const found = await deps.series.findByKey(market, { offerId, variantId });
    if (found === null) return err(write.missingSeries);
    // The series' seller copy must be the seller catalog names (design 2.3, 5.2).
    if (found.state.sellerId !== offer.sellerId) return ok('not-yours' as const);
    if (found.persistedVersion !== write.expectedVersion) return err(STALE);
    const applied = write.apply(found, deps.clock.now());
    if (!applied.ok) return applied;
    await deps.series.save(market, found);
    await write.audit(found, applied.value);
    await deps.outbox.append(context, found.pendingEvents);
    return ok({ value: applied.value, series: found });
  });
  if (!written.ok) return written;
  if (written.value === 'not-yours') {
    return refuse(deps, context, logger, accountId, offerId, variantId, 'not-yours');
  }
  return ok(written.value);
}

/** Every cause: the same refusal unit, the same answer (design 5.2; Hassan finding 2). */
async function refuse(
  deps: OfferWriteRefusalDependencies,
  context: CallContext,
  logger: Logger,
  accountId: Id<'Account'>,
  offerId: Id<'Offer'>,
  variantId: Id<'Variant'>,
  cause: Parameters<typeof recordOfferWriteRefusal>[2]['cause'],
): Promise<Result<never, typeof NOT_FOUND>> {
  const audit = await recordOfferWriteRefusal(deps, context, {
    accountId,
    offerId,
    variantId,
    cause,
  });
  // The cause stays in the audit row: the log names only what was written.
  logger.log({
    msg: 'pricing.seller-series-write.offer-not-found',
    offerId,
    audit,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return err(NOT_FOUND);
}

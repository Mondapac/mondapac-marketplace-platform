import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { PriceSeriesRetired, RegularPriceSuperseded } from '../domain/audit';
import type { PriceSeries, RetireCause } from '../domain/price-series';
import type { PriceSeriesRepository } from './ports/price-series.repository';
import type { RetirementTombstoneRepository } from './ports/retirement-tombstone.repository';

export interface RetirementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly tombstones: RetirementTombstoneRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/** What one delivery of a retirement event did. */
export type RetirementOutput =
  | {
      readonly code: 'pricing.series-retired';
      readonly series: number;
      readonly superseded: number;
    }
  | { readonly code: 'pricing.retire.already-handled' };

/**
 * The body both retirement handlers share (pricing design 6.4). Called inside the handler's
 * `serializable` unit with the inbox row: every non-retired series found is retired (pending
 * records superseded with the cause), saved, audited and its events appended; a retired series
 * is left as it is. The tombstone is written whether or not a series exists, so a price written
 * after the event can never create a live series (Hassan finding 3).
 */
export async function retireSeries(
  deps: RetirementDependencies,
  context: CallContext,
  cause: RetireCause,
  load: () => Promise<readonly PriceSeries[]>,
  recordTombstone: (retiredAt: ReturnType<Clock['now']>) => Promise<boolean>,
): Promise<Result<{ series: number; superseded: number }, never>> {
  const { market } = context;
  const now = deps.clock.now();
  const found = await load();
  await recordTombstone(now);
  let retired = 0;
  let superseded = 0;
  for (const series of found) {
    if (series.state.retiredAt !== null) continue;
    const replaced = series.retire(cause, now);
    await deps.series.save(market, series);
    const { id, offerId, variantId } = series.state;
    for (const record of replaced) {
      await deps.audit.record(
        context,
        RegularPriceSuperseded.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: record.id,
            cause,
            supersededByRecordId: null,
          },
        }),
      );
    }
    await deps.audit.record(
      context,
      PriceSeriesRetired.entry(id, { after: { offerId, variantId, cause } }),
    );
    await deps.outbox.append(context, series.pendingEvents);
    retired += 1;
    superseded += replaced.length;
  }
  return ok({ series: retired, superseded });
}

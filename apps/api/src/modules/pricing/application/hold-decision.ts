import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PriceSeries } from '../domain/price-series';
import type { PriceSeriesRepository } from './ports/price-series.repository';

/** The refusals the two decision use cases share (pricing design 5.5). */
export type HoldDecisionFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  /** Unknown, or another Market's: one answer (design 5.2). */
  | { readonly code: 'pricing.hold.not-found' }
  | { readonly code: 'pricing.hold.not-pending' }
  /** H4: the decider submitted the record. */
  | { readonly code: 'pricing.hold.own-submission' }
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.amount-out-of-range' }
  | { readonly code: 'pricing.currency-mismatch' }
  /** A concurrent write got there first: reload the queue. */
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'conflict.retry' };

export interface HoldDecisionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/** What a decision changes in the loaded series; throws nothing, returns the audit rows' source. */
export type ApplyDecision<T> = (
  series: PriceSeries,
  now: ReturnType<Clock['now']>,
) => Result<T, HoldDecisionFailure>;

/**
 * The one unit of an approval or a rejection (design 3.1 rows 3 and 4, 9): load the series that
 * holds the record **in the context's Market** (READ COMMITTED; the version check of the save is
 * the guard against a concurrent seller write or retirement: the loser is `conflict.stale`),
 * apply the decision in the aggregate, save, write the audit rows and the events in the same
 * unit. The record id is the guard against a stale screen: a record that is no longer pending is
 * `pricing.hold.not-pending`.
 */
export async function decideHold<T>(
  deps: HoldDecisionDependencies,
  context: CallContext,
  recordId: Id<'RegularPriceRecord'>,
  apply: ApplyDecision<T>,
  audit: (series: PriceSeries, decided: T) => Promise<void>,
): Promise<Result<{ readonly series: PriceSeries; readonly decided: T }, HoldDecisionFailure>> {
  const { market } = context;
  try {
    return await deps.unitOfWork.run(market, async () => {
      const series = await deps.series.findByRecordId(market, recordId);
      if (series === null) return err({ code: 'pricing.hold.not-found' as const });
      const applied = apply(series, deps.clock.now());
      if (!applied.ok) return applied;
      await deps.series.save(market, series);
      await audit(series, applied.value);
      await deps.outbox.append(context, series.pendingEvents);
      return ok({ series, decided: applied.value });
    });
  } catch (error) {
    if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
    if (error instanceof TransactionConflictError) return err({ code: 'conflict.retry' });
    throw error;
  }
}

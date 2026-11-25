import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  abandonedCartsDayDue,
  approximateValueOf,
  idleCutoffOf,
} from '../../domain/abandoned-carts';
import type { AbandonedCartSources } from '../ports/abandoned-cart-sources';
import type { AbandonedCartsStore } from '../ports/abandoned-carts-store';
import type { MarketZone } from '../ports/market-zone';

export interface SnapshotAbandonedCartsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: AbandonedCartsStore;
  readonly sources: AbandonedCartSources;
  readonly zone: Pick<MarketZone, 'zoneOf' | 'currencyOf'>;
  readonly clock: Clock;
}

export interface SnapshotAbandonedCartsCounts {
  /** 1 when this run wrote yesterday's row. */
  readonly written: number;
  /** 1 when another run wrote it first (its row is kept). */
  readonly alreadyWritten: number;
  /** 1 when cart could not count now; tried again next run while the day is still yesterday. */
  readonly failedDays: number;
}

const logger = new Logger('SnapshotAbandonedCarts');

/**
 * `reporting.snapshot-abandoned-carts` (dashboards v2, phase 2): the nightly abandoned-cart
 * snapshot. Rule `system`. Once the Market's yesterday (its zone, the injected Clock) ended at
 * least two hours ago and has no row, it asks cart for the carts untouched since 24 hours before
 * that day's end, as they are now, and writes the count and the approximate value in the Market's
 * currency once. Only yesterday is written: a cart's state cannot be read for an older day, so a
 * day missed while the worker was down stays without a row. A failure is logged by day and reason
 * (no id) and tried again next hour.
 */
export class SnapshotAbandonedCarts extends UseCase<
  Record<string, never>,
  SnapshotAbandonedCartsCounts,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.snapshot-abandoned-carts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SnapshotAbandonedCartsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SnapshotAbandonedCartsCounts, never>> {
    const { market } = context;
    const zone = this.deps.zone.zoneOf(market);
    const counts = { written: 0, alreadyWritten: 0, failedDays: 0 };
    const candidate = abandonedCartsDayDue(this.deps.clock.now(), zone, false);
    if (candidate === null) return ok(counts);
    const recorded = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.store.hasDay(market, candidate)),
      { readOnly: true },
    );
    if (!recorded.ok) throw new Error('reporting.snapshot-abandoned-carts: read refused');
    if (recorded.value) return ok(counts);
    const day = candidate;
    // Cart is read before the unit, in its own unit.
    const totals = await this.deps.sources.abandonedCartsAt(context, idleCutoffOf(day, zone));
    if (!totals.ok) {
      logger.warn({
        msg: 'reporting.abandoned-carts-snapshot.day-failed',
        day,
        reason: totals.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok({ ...counts, failedDays: 1 });
    }
    const currency = this.deps.zone.currencyOf(market);
    const value = approximateValueOf(totals.value.values, currency);
    if (value === null) {
      // Counts only: the currencies say nothing about anyone.
      logger.warn({
        msg: 'reporting.abandoned-carts-snapshot.mixed-currency',
        day,
        currencies: totals.value.values.map((total) => total.currency),
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    const recordedAt = this.deps.clock.now();
    const unit = await this.deps.unitOfWork.run(market, async () =>
      ok(
        await this.deps.store.insertDay(
          market,
          { day, carts: totals.value.carts, value },
          recordedAt,
        ),
      ),
    );
    if (!unit.ok) throw new Error('reporting.snapshot-abandoned-carts: write refused');
    return ok(unit.value ? { ...counts, written: 1 } : { ...counts, alreadyWritten: 1 });
  }
}

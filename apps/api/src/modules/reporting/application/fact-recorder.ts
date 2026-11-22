import type { MarketContext } from '@mondapac/shared-kernel';
import {
  marketDayOf,
  refundEntries,
  saleEntries,
  type CategoryGoods,
  type RefundFact,
  type SellerOrderFact,
} from '../domain/facts';
import { distinctSellerDays, rollUpSellerDay, type SellerDay } from '../domain/rollup';
import type { FactStore, SellerOrderDays } from './ports/fact-store';
import type { MarketZone } from './ports/market-zone';
import type { RollupStore } from './ports/rollup-store';

export interface FactRecorderDependencies {
  readonly facts: FactStore;
  readonly rollups: RollupStore;
  readonly zone: MarketZone;
}

/**
 * Records the facts read from an owning module's facade and rebuilds the rollups of every seller
 * day they touch, before and after the write. The one write path of `reporting`: the event worker,
 * the nightly reconcile and the history backfill all call it, inside their own unit, so the facts
 * and the rollups always change together.
 *
 * It is idempotent: recording the same facts again writes the same rows. It converges whatever the
 * order of the calls, because a fact is the owner's state as read, not a delta.
 */
export class FactRecorder {
  constructor(private readonly deps: FactRecorderDependencies) {}

  /** A seller order and its goods by category, as ordering and catalog report them now. */
  async recordSellerOrder(
    market: MarketContext,
    order: SellerOrderFact,
    goods: readonly CategoryGoods[],
  ): Promise<void> {
    const zone = this.deps.zone.zoneOf(market);
    const day = (at: SellerOrderFact['paidAt']) => (at === null ? null : marketDayOf(at, zone));
    const days: SellerOrderDays = {
      paidDay: day(order.paidAt),
      cancelledDay: day(order.cancelledAt),
      shippedDay: day(order.shippedAt),
      deliveredDay: day(order.deliveredAt),
    };
    const before = await this.deps.facts.putSellerOrder(market, order, days);
    const entries = saleEntries(order, goods, zone);
    const entriesBefore = await this.deps.facts.replaceEntries(
      market,
      'sale',
      order.sellerOrderId,
      entries,
    );
    const after = [days.paidDay, days.cancelledDay, days.shippedDay, days.deliveredDay]
      .filter((value) => value !== null)
      .map((marketDay) => ({ marketDay, sellerId: order.sellerId }));
    await this.refresh(market, [...before, ...entriesBefore, ...after]);
  }

  /** A succeeded refund and its goods by category. */
  async recordRefund(
    market: MarketContext,
    refund: RefundFact,
    goods: readonly CategoryGoods[],
  ): Promise<void> {
    const zone = this.deps.zone.zoneOf(market);
    const refundDay = marketDayOf(refund.refundedAt, zone);
    const before = await this.deps.facts.putRefund(market, refund, refundDay);
    const entriesBefore = await this.deps.facts.replaceEntries(
      market,
      'refund',
      refund.refundId,
      refundEntries(refund, goods, zone),
    );
    await this.refresh(market, [
      ...before,
      ...entriesBefore,
      { marketDay: refundDay, sellerId: refund.sellerId },
    ]);
  }

  /** Rebuilds the rollups of each seller day from its facts. */
  async refresh(market: MarketContext, keys: readonly SellerDay[]): Promise<void> {
    for (const key of distinctSellerDays(keys)) {
      const facts = await this.deps.facts.loadSellerDay(market, key);
      await this.deps.rollups.replaceSellerDay(market, key, rollUpSellerDay(facts));
    }
  }
}

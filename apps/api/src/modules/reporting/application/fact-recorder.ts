import type { MarketContext } from '@mondapac/shared-kernel';
import {
  checkedBuyerFirst,
  checkedDelivery,
  keepKnownInstants,
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
 *
 * Callers run it in a SERIALIZABLE unit (Mojtaba F1): two events of one seller day each read the
 * day's facts and replace its rollup rows, so under READ COMMITTED one could miss the other's
 * fact. Serializable turns that into a 40001 the platform retries.
 *
 * It refuses, before writing, a fact in another currency than the Market's, and goods by category
 * that do not add up to the fact's goods (Hassan F3, F4): the caller maps goods it cannot place to
 * `UNKNOWN_CATEGORY` rather than leave them out.
 */
export class FactRecorder {
  constructor(private readonly deps: FactRecorderDependencies) {}

  /** A seller order and its goods by category, as ordering and catalog report them now. */
  async recordSellerOrder(
    market: MarketContext,
    order: SellerOrderFact,
    goods: readonly CategoryGoods[],
  ): Promise<void> {
    await this.refresh(market, await this.putSellerOrder(market, order, goods));
  }

  /** A succeeded refund and its goods by category. */
  async recordRefund(
    market: MarketContext,
    refund: RefundFact,
    goods: readonly CategoryGoods[],
  ): Promise<void> {
    await this.refresh(market, await this.putRefund(market, refund, goods));
  }

  /**
   * Many facts in one unit, with one rebuild of each seller day they touch at the end, so a page
   * of facts of one busy day rebuilds it once, not once per fact (the reconcile and the backfill).
   */
  async recordBatch(
    market: MarketContext,
    batch: {
      readonly sellerOrders: readonly {
        readonly order: SellerOrderFact;
        readonly goods: readonly CategoryGoods[];
      }[];
      readonly refunds: readonly {
        readonly refund: RefundFact;
        readonly goods: readonly CategoryGoods[];
      }[];
    },
  ): Promise<void> {
    const keys: SellerDay[] = [];
    // Facts in id order, so two units write the same rows in one order (Mojtaba, PR 10b note 4).
    const sellerOrders = [...batch.sellerOrders].sort((a, b) =>
      a.order.sellerOrderId < b.order.sellerOrderId ? -1 : 1,
    );
    const refunds = [...batch.refunds].sort((a, b) =>
      a.refund.refundId < b.refund.refundId ? -1 : 1,
    );
    for (const { order, goods } of sellerOrders) {
      keys.push(...(await this.putSellerOrder(market, order, goods)));
    }
    for (const { refund, goods } of refunds) {
      keys.push(...(await this.putRefund(market, refund, goods)));
    }
    await this.refresh(market, keys);
  }

  /** Writes the seller order's fact and entries; the seller days to rebuild. */
  private async putSellerOrder(
    market: MarketContext,
    read: SellerOrderFact,
    goods: readonly CategoryGoods[],
  ): Promise<SellerDay[]> {
    this.checkCurrency(market, read.currency);
    // A fact read before a newer one was written keeps what the stored one already knows.
    const order = keepKnownInstants(
      read,
      await this.deps.facts.sellerOrderInstants(market, read.sellerOrderId),
    );
    checkedDelivery(order.delivery);
    checkedBuyerFirst(order.buyerFirst, order.paidAt);
    checkGoods(goods, order.goods.amount, order.goods.tax, `seller order ${order.sellerOrderId}`);
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
    return [...before, ...entriesBefore, ...after];
  }

  /** Writes the refund's fact and entries; the seller days to rebuild. */
  private async putRefund(
    market: MarketContext,
    refund: RefundFact,
    goods: readonly CategoryGoods[],
  ): Promise<SellerDay[]> {
    this.checkCurrency(market, refund.currency);
    checkGoods(
      goods,
      refund.total.amount - refund.shipping.amount,
      refund.total.tax - refund.shipping.tax,
      `refund ${refund.refundId}`,
    );
    const zone = this.deps.zone.zoneOf(market);
    const refundDay = marketDayOf(refund.refundedAt, zone);
    const before = await this.deps.facts.putRefund(market, refund, refundDay);
    const entriesBefore = await this.deps.facts.replaceEntries(
      market,
      'refund',
      refund.refundId,
      refundEntries(refund, goods, zone),
    );
    return [...before, ...entriesBefore, { marketDay: refundDay, sellerId: refund.sellerId }];
  }

  private checkCurrency(market: MarketContext, currency: string): void {
    const expected = this.deps.zone.currencyOf(market);
    if (currency !== expected) {
      throw new RangeError(`reporting: a fact in ${currency} for a Market priced in ${expected}`);
    }
  }

  /** Rebuilds the rollups of each seller day from its facts. */
  async refresh(market: MarketContext, keys: readonly SellerDay[]): Promise<void> {
    for (const key of distinctSellerDays(keys)) {
      const facts = await this.deps.facts.loadSellerDay(market, key);
      await this.deps.rollups.replaceSellerDay(market, key, rollUpSellerDay(facts));
    }
  }
}

/** The goods by category must add up to the fact's goods: nothing is dropped or counted twice. */
function checkGoods(
  goods: readonly CategoryGoods[],
  amount: bigint,
  tax: bigint,
  what: string,
): void {
  const sum = goods.reduce(
    (total, part) => ({
      amount: total.amount + part.goods.amount,
      tax: total.tax + part.goods.tax,
    }),
    { amount: 0n, tax: 0n },
  );
  if (sum.amount !== amount || sum.tax !== tax) {
    throw new RangeError(`reporting: the goods by category of ${what} do not add up to its goods`);
  }
}

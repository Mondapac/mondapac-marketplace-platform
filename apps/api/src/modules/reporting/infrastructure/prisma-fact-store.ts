import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  ReportingFactConflict,
  type FactStore,
  type SellerOrderDays,
} from '../application/ports/fact-store';
import {
  parseMarketDay,
  type MarketDay,
  type RefundFact,
  type SalesEntry,
  type SalesEntryKind,
  type SellerOrderFact,
} from '../domain/facts';
import type { SellerDay, SellerDayFacts } from '../domain/rollup';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toOptionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
/** A `date` column holds the day at UTC midnight in the client; this is only its carrier. */
export const dayToDate = (day: MarketDay): Date => new Date(`${day}T00:00:00.000Z`);
export const dateToDay = (date: Date): MarketDay => parseMarketDay(date.toISOString().slice(0, 10));
const optionalDay = (date: Date | null): MarketDay | null =>
  date === null ? null : dateToDay(date);

/**
 * {@link FactStore} on `reporting.seller_orders`, `reporting.refunds` and
 * `reporting.sales_entries`. Every statement goes through `PrismaService.tx(market)` with
 * `marketId` in `where`; it reads no table of another module.
 */
export class PrismaFactStore implements FactStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => Temporal.Instant,
  ) {}

  async putSellerOrder(
    market: MarketContext,
    fact: SellerOrderFact,
    days: SellerOrderDays,
  ): Promise<readonly SellerDay[]> {
    const client = this.prisma.tx(market);
    const key = { marketId: market.marketId, sellerOrderId: fact.sellerOrderId };
    const previous = await client.reportingSellerOrder.findFirst({
      where: key,
      select: {
        orderId: true,
        sellerId: true,
        currency: true,
        paidDay: true,
        cancelledDay: true,
        shippedDay: true,
        deliveredDay: true,
      },
    });
    const at = toDate(this.now());
    const measures = {
      goodsAmount: fact.goods.amount,
      goodsTaxAmount: fact.goods.tax,
      units: fact.units,
      shippingAmount: fact.shipping.amount,
      shippingTaxAmount: fact.shipping.tax,
      paidAt: toOptionalDate(fact.paidAt),
      paidDay: days.paidDay === null ? null : dayToDate(days.paidDay),
      cancelledAt: toOptionalDate(fact.cancelledAt),
      cancelledDay: days.cancelledDay === null ? null : dayToDate(days.cancelledDay),
      shippedAt: toOptionalDate(fact.shippedAt),
      shippedDay: days.shippedDay === null ? null : dayToDate(days.shippedDay),
      shippedOnTime: fact.shippedOnTime,
      deliveredAt: toOptionalDate(fact.deliveredAt),
      deliveredDay: days.deliveredDay === null ? null : dayToDate(days.deliveredDay),
      updatedAt: at,
    };
    if (previous === null) {
      // A refund recorded before its seller order must name the same seller, order and currency
      // (Hassan, PR 9 re-review): the check that a refund meets otherwise runs one way only.
      const refunded = await client.reportingRefund.findFirst({
        where: {
          marketId: market.marketId,
          sellerOrderId: fact.sellerOrderId,
          OR: [
            { orderId: { not: fact.orderId } },
            { sellerId: { not: fact.sellerId } },
            { currency: { not: fact.currency } },
          ],
        },
        select: { refundId: true },
      });
      if (refunded !== null) throw new ReportingFactConflict('seller-order', fact.sellerOrderId);
      await client.reportingSellerOrder.create({
        data: {
          ...key,
          tenantId: market.tenantId,
          orderId: fact.orderId,
          sellerId: fact.sellerId,
          currency: fact.currency,
          recordedAt: at,
          ...measures,
        },
      });
      return [];
    }
    // The keys, seller, order and currency of a fact never change (Hassan F1): a fact that says
    // otherwise is a bug upstream, refused before anything moves to another seller.
    if (
      previous.orderId !== fact.orderId ||
      previous.sellerId !== fact.sellerId ||
      previous.currency !== fact.currency
    ) {
      throw new ReportingFactConflict('seller-order', fact.sellerOrderId);
    }
    await client.reportingSellerOrder.updateMany({ where: key, data: measures });
    const sellerId = previous.sellerId as Id<'Seller'>;
    return [previous.paidDay, previous.cancelledDay, previous.shippedDay, previous.deliveredDay]
      .map(optionalDay)
      .filter((day) => day !== null)
      .map((marketDay) => ({ marketDay, sellerId }));
  }

  async putRefund(
    market: MarketContext,
    fact: RefundFact,
    refundDay: MarketDay,
  ): Promise<readonly SellerDay[]> {
    const client = this.prisma.tx(market);
    const key = { marketId: market.marketId, refundId: fact.refundId };
    const previous = await client.reportingRefund.findFirst({
      where: key,
      select: {
        orderId: true,
        sellerOrderId: true,
        sellerId: true,
        currency: true,
        refundDay: true,
      },
    });
    // A refund belongs to the seller order reporting knows, when it knows it (Hassan F1).
    const sellerOrder = await client.reportingSellerOrder.findFirst({
      where: { marketId: market.marketId, sellerOrderId: fact.sellerOrderId },
      select: { orderId: true, sellerId: true, currency: true },
    });
    if (
      sellerOrder !== null &&
      (sellerOrder.orderId !== fact.orderId ||
        sellerOrder.sellerId !== fact.sellerId ||
        sellerOrder.currency !== fact.currency)
    ) {
      throw new ReportingFactConflict('refund', fact.refundId);
    }
    const at = toDate(this.now());
    const measures = {
      amount: fact.total.amount,
      taxAmount: fact.total.tax,
      shippingAmount: fact.shipping.amount,
      shippingTaxAmount: fact.shipping.tax,
      refundedAt: toDate(fact.refundedAt),
      refundDay: dayToDate(refundDay),
      updatedAt: at,
    };
    if (previous === null) {
      await client.reportingRefund.create({
        data: {
          ...key,
          tenantId: market.tenantId,
          orderId: fact.orderId,
          sellerOrderId: fact.sellerOrderId,
          sellerId: fact.sellerId,
          currency: fact.currency,
          recordedAt: at,
          ...measures,
        },
      });
      return [];
    }
    if (
      previous.orderId !== fact.orderId ||
      previous.sellerOrderId !== fact.sellerOrderId ||
      previous.sellerId !== fact.sellerId ||
      previous.currency !== fact.currency
    ) {
      throw new ReportingFactConflict('refund', fact.refundId);
    }
    await client.reportingRefund.updateMany({ where: key, data: measures });
    return [
      { marketDay: dateToDay(previous.refundDay), sellerId: previous.sellerId as Id<'Seller'> },
    ];
  }

  async replaceEntries(
    market: MarketContext,
    kind: SalesEntryKind,
    sourceId: string,
    entries: readonly SalesEntry[],
  ): Promise<readonly SellerDay[]> {
    if (entries.some((entry) => entry.kind !== kind || entry.sourceId !== sourceId)) {
      throw new TypeError('replaceEntries: every entry must belong to the source it replaces');
    }
    const client = this.prisma.tx(market);
    const where = { marketId: market.marketId, kind, sourceId };
    const previous = await client.reportingSalesEntry.findMany({
      where,
      select: { marketDay: true, sellerId: true },
      distinct: ['marketDay', 'sellerId'],
    });
    await client.reportingSalesEntry.deleteMany({ where });
    if (entries.length > 0) {
      const at = toDate(this.now());
      await client.reportingSalesEntry.createMany({
        data: entries.map((entry) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: entry.kind,
          sourceId: entry.sourceId,
          categoryId: entry.categoryId,
          orderId: entry.orderId,
          sellerOrderId: entry.sellerOrderId,
          sellerId: entry.sellerId,
          currency: entry.currency,
          marketDay: dayToDate(entry.marketDay),
          amount: entry.amount,
          taxAmount: entry.tax,
          units: entry.units,
          recordedAt: at,
        })),
      });
    }
    return previous.map((row) => ({
      marketDay: dateToDay(row.marketDay),
      sellerId: row.sellerId as Id<'Seller'>,
    }));
  }

  async loadSellerDay(market: MarketContext, key: SellerDay): Promise<SellerDayFacts> {
    const client = this.prisma.tx(market);
    const day = dayToDate(key.marketDay);
    const scope = { marketId: market.marketId, sellerId: key.sellerId };
    const [orders, refunds, entries] = await Promise.all([
      client.reportingSellerOrder.findMany({
        where: {
          ...scope,
          OR: [{ paidDay: day }, { cancelledDay: day }, { shippedDay: day }, { deliveredDay: day }],
        },
        orderBy: { sellerOrderId: 'asc' },
      }),
      client.reportingRefund.findMany({
        where: { ...scope, refundDay: day },
        orderBy: { refundId: 'asc' },
        select: {
          currency: true,
          amount: true,
          taxAmount: true,
          shippingAmount: true,
          shippingTaxAmount: true,
        },
      }),
      client.reportingSalesEntry.findMany({
        where: { ...scope, marketDay: day },
        orderBy: [{ kind: 'asc' }, { sourceId: 'asc' }, { categoryId: 'asc' }],
      }),
    ]);
    const same = (date: Date | null): boolean => date !== null && date.getTime() === day.getTime();
    return {
      sellerOrders: orders.map((row) => ({
        sellerOrderId: row.sellerOrderId,
        currency: row.currency,
        goodsAmount: row.goodsAmount,
        goodsTax: row.goodsTaxAmount,
        units: row.units,
        shippingAmount: row.shippingAmount,
        shippingTax: row.shippingTaxAmount,
        paidOnDay: same(row.paidDay),
        cancelledOnDay: same(row.cancelledDay),
        shippedOnDay: same(row.shippedDay),
        shippedOnTime: row.shippedOnTime,
        deliveredOnDay: same(row.deliveredDay),
      })),
      refunds: refunds.map((row) => ({
        currency: row.currency,
        amount: row.amount,
        tax: row.taxAmount,
        shippingAmount: row.shippingAmount,
        shippingTax: row.shippingTaxAmount,
      })),
      entries: entries.map((row) => ({
        kind: row.kind as SalesEntryKind,
        sourceId: row.sourceId,
        categoryId: row.categoryId as Id<'Category'>,
        orderId: row.orderId as Id<'Order'>,
        sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
        sellerId: row.sellerId as Id<'Seller'>,
        currency: row.currency,
        marketDay: dateToDay(row.marketDay),
        amount: row.amount,
        tax: row.taxAmount,
        units: row.units,
      })),
    };
  }
}

import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { MarketDay } from '../domain/facts';
import { PrismaSellerKpiReader } from './prisma-seller-kpi-reader';

// The statements of the seller KPI reader: each carries the Market, the seller and the currency,
// so no row of another seller can be read, and the day ranges are the ones asked for.

describe('PrismaSellerKpiReader', () => {
  const market = testMarketContext('AU', 'default');
  const seller = '0190f000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
  const calls: { model: string; args: { where: Record<string, unknown> } }[] = [];
  const delegate = (model: string, result: unknown[]) => ({
    findMany: (args: { where: Record<string, unknown> }) => {
      calls.push({ model, args });
      return Promise.resolve(result);
    },
    groupBy: (args: { where: Record<string, unknown> }) => {
      calls.push({ model, args });
      return Promise.resolve(result);
    },
  });
  const prisma = {
    tx: () => ({
      reportingDailySellerSales: delegate('daily', [
        {
          marketDay: new Date('2026-11-22T00:00:00Z'),
          ordersPaid: 1,
          goodsAmount: 1100n,
          goodsTaxAmount: 100n,
          units: 2,
          ordersCancelled: 0,
          ordersShipped: 0,
          ordersShippedOnTime: 0,
          refunds: 0,
          refundGoodsAmount: 0n,
          refundGoodsTaxAmount: 0n,
          refundShippingAmount: 0n,
          refundShippingTaxAmount: 0n,
          refreshedAt: new Date('2026-11-22T01:00:00Z'),
        },
      ]),
      reportingDailyCategorySales: delegate('categories', [
        {
          categoryId: '0190f000-0000-7000-8000-0000000000d1',
          _sum: {
            orders: 1,
            salesAmount: 1100n,
            salesTaxAmount: 100n,
            salesUnits: 2,
            refundAmount: null,
          },
        },
      ]),
    }),
  } as unknown as PrismaService;

  it('limits every statement to the Market, the seller and the currency', async () => {
    const day = (text: string) => text as MarketDay;
    const read = await new PrismaSellerKpiReader(prisma).read(
      market,
      seller,
      'AUD',
      { from: day('2026-11-16'), to: day('2026-11-22') },
      { from: day('2026-11-09'), to: day('2026-11-15') },
    );
    expect(calls).toHaveLength(2);
    for (const { args } of calls) {
      expect(args.where).toMatchObject({ marketId: 'AU', sellerId: seller, currency: 'AUD' });
    }
    expect(calls[0]?.args.where.marketDay).toEqual({
      gte: new Date('2026-11-09T00:00:00Z'),
      lte: new Date('2026-11-22T00:00:00Z'),
    });
    expect(calls[1]?.args.where.marketDay).toEqual({
      gte: new Date('2026-11-16T00:00:00Z'),
      lte: new Date('2026-11-22T00:00:00Z'),
    });
    expect(read.daily[0]).toMatchObject({ marketDay: '2026-11-22', goodsAmount: 1100n });
    expect(read.categories[0]).toMatchObject({ salesAmount: 1100n, refundAmount: 0n });
  });
});

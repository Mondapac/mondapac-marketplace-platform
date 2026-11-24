import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import { UNKNOWN_CATEGORY, type SellerOrderFact } from '../../src/modules/reporting/domain/facts';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { PrismaAdminKpiReader } from '../../src/modules/reporting/infrastructure/prisma-admin-kpi-reader';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The admin KPI read on PostgreSQL as the application role (dashboards upgrade phase 5): the
// daily rollups of every seller are summed per Market day, only inside the range, only in the
// Market's currency and only for the caller's Market.

const ZONES: Record<string, string> = { AU: 'Australia/Brisbane', ZZ: 'Asia/Tokyo' };
const CURRENCIES: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const at = (text: string) => Temporal.Instant.from(text);
const day = (text: string) => text as MarketDay;

describe.each(TEST_MARKETS)('the admin KPI reader in market %s (database)', (code) => {
  // One month per Market fixture: the rows of the other Market's run stay outside this range.
  const M = code === TEST_MARKETS[0] ? '03' : '04';
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let recorder: FactRecorder;
  let reader: PrismaAdminKpiReader;

  beforeAll(() => {
    db = createPersistence();
    const now = () => Temporal.Now.instant();
    recorder = new FactRecorder({
      facts: new PrismaFactStore(db.service, now),
      rollups: new PrismaRollupStore(db.service, now),
      zone: {
        zoneOf: (target: MarketContext) => ZONES[target.marketId] as string,
        currencyOf: (target: MarketContext) => CURRENCIES[target.marketId] as string,
      },
    });
    reader = new PrismaAdminKpiReader(db.service);
  });
  afterAll(() => db.close());

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });

  const order = (
    sellerId: Id<'Seller'>,
    paidAt: string,
    goods: bigint,
    overrides: Partial<SellerOrderFact> = {},
    orderCurrency: string = currency,
  ): SellerOrderFact => ({
    sellerOrderId: idOf<'SellerOrder'>(),
    orderId: idOf<'Order'>(),
    sellerId,
    currency: orderCurrency,
    goods: { amount: goods, tax: goods / 11n },
    units: 1,
    shipping: { amount: 0n, tax: 0n },
    paidAt: at(paidAt),
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    ...overrides,
  });

  const record = (target: MarketContext, fact: SellerOrderFact) =>
    within(target, () =>
      recorder.recordSellerOrder(target, fact, [
        { categoryId: UNKNOWN_CATEGORY, goods: fact.goods, units: fact.units },
      ]),
    );

  it('sums every seller per day inside the range, in the currency and Market asked for', async () => {
    // Mid-day UTC: the same calendar day in Brisbane and Tokyo. A month of their own keeps these rows away
    // from the other specs' November days.
    const a = idOf<'Seller'>();
    const b = idOf<'Seller'>();
    await record(market, order(a, `2026-${M}-10T03:00:00Z`, 11_000n));
    await record(
      market,
      order(b, `2026-${M}-10T04:00:00Z`, 22_000n, {
        shippedAt: at(`2026-${M}-11T03:00:00Z`),
        shippedOnTime: true,
      }),
    );
    await record(market, order(a, `2026-${M}-12T03:00:00Z`, 5_500n));
    await record(market, order(a, `2026-${M}-20T03:00:00Z`, 99_000n)); // outside the range
    await record(
      other,
      order(a, `2026-${M}-10T03:00:00Z`, 1_000_000n, {}, CURRENCIES[otherMarketOf(code)]),
    );

    const range = { from: day(`2026-${M}-10`), to: day(`2026-${M}-14`) };
    const readIn = async (target: MarketContext, rowCurrency: string, readRange: typeof range) => {
      const unit = await db.unitOfWork.run(
        target,
        async () => ok(await reader.dailyTotals(target, rowCurrency, readRange)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    const out = await readIn(market, currency, range);
    expect(out.days.map((row) => [row.day, row.ordersPaid, row.goodsAmount, row.goodsTax])).toEqual(
      [
        [`2026-${M}-10`, 2, 33_000n, 3_000n],
        [`2026-${M}-11`, 0, 0n, 0n],
        [`2026-${M}-12`, 1, 5_500n, 500n],
      ],
    );
    const shipped = out.days.find((row) => row.day === `2026-${M}-11`);
    expect(shipped).toMatchObject({ ordersShipped: 1, ordersShippedOnTime: 1 });
    expect(out.refreshedAt).not.toBeNull();

    // Another currency, or nothing in the range, reads as nothing, never as zeros of a day.
    expect((await readIn(market, 'XXX', range)).days).toEqual([]);
    const none = await readIn(market, currency, {
      from: day('2026-02-01'),
      to: day('2026-02-02'),
    });
    expect(none).toEqual({ days: [], refreshedAt: null });
  });

  it('ranks the sellers by goods sold, biggest first, inside the range, the currency and the Market', async () => {
    const big = idOf<'Seller'>();
    const mid = idOf<'Seller'>();
    const small = idOf<'Seller'>();
    const noSale = idOf<'Seller'>();
    const tieA = idOf<'Seller'>();
    const tieB = idOf<'Seller'>();
    await record(market, order(mid, `2026-${M}-22T03:00:00Z`, 20_000n));
    await record(market, order(mid, `2026-${M}-23T03:00:00Z`, 20_000n)); // two days of one seller add up
    await record(
      market,
      order(big, `2026-${M}-22T03:00:00Z`, 90_000n, {
        shippedAt: at(`2026-${M}-22T05:00:00Z`),
        shippedOnTime: true,
      }),
    );
    await record(market, order(small, `2026-${M}-23T03:00:00Z`, 1_100n));
    // Equal totals: the lower seller id comes first.
    await record(market, order(tieA, `2026-${M}-23T03:00:00Z`, 1_100n));
    await record(market, order(tieB, `2026-${M}-23T03:00:00Z`, 1_100n));
    await record(market, order(noSale, `2026-${M}-27T03:00:00Z`, 500_000n)); // outside the range
    await record(
      other,
      order(small, `2026-${M}-22T03:00:00Z`, 9_000_000n, {}, CURRENCIES[otherMarketOf(code)]),
    );

    const range = { from: day(`2026-${M}-22`), to: day(`2026-${M}-24`) };
    const readTop = async (rowCurrency: string, limit: number) => {
      const unit = await db.unitOfWork.run(
        market,
        async () => ok(await reader.topSellers(market, rowCurrency, range, limit)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    const top = await readTop(currency, 5);
    const ties = [small, tieA, tieB].sort();
    expect(top.map((row) => [row.sellerId, row.goodsAmount, row.ordersPaid])).toEqual([
      [big, 90_000n, 1],
      [mid, 40_000n, 2],
      ...ties.map((sellerId) => [sellerId, 1_100n, 1]),
    ]);
    expect(top[0]).toMatchObject({ ordersShipped: 1, ordersShippedOnTime: 1 });
    expect((await readTop(currency, 2)).map((row) => row.sellerId)).toEqual([big, mid]);
    expect((await readTop(currency, 4)).map((row) => row.sellerId)).toEqual([
      big,
      mid,
      ties[0]!,
      ties[1]!,
    ]);
    expect(await readTop('XXX', 5)).toEqual([]);

    // The same sellers, counted once each however many days or orders they have.
    const countIn = async (rowCurrency: string) => {
      const unit = await db.unitOfWork.run(
        market,
        async () => ok(await reader.sellersWithOrders(market, rowCurrency, range)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    expect(await countIn(currency)).toBe(5);
    expect(await countIn('XXX')).toBe(0);
  });

  it('ranks the categories by goods sold across sellers, inside the range, the currency and the Market', async () => {
    const meat = idOf<'Category'>();
    const bakery = idOf<'Category'>();
    const dairy = idOf<'Category'>();
    const sellerA = idOf<'Seller'>();
    const sellerB = idOf<'Seller'>();
    const inCategories = (
      target: MarketContext,
      fact: SellerOrderFact,
      split: readonly [Id<'Category'>, bigint][],
    ) =>
      within(target, () =>
        recorder.recordSellerOrder(
          target,
          fact,
          split.map(([categoryId, amount]) => ({
            categoryId,
            goods: { amount, tax: amount / 11n },
            units: 1,
          })),
        ),
      );
    const oneOrder = (seller: Id<'Seller'>, paidAt: string, split: [Id<'Category'>, bigint][]) => {
      const total = split.reduce((sum, [, amount]) => sum + amount, 0n);
      return inCategories(market, order(seller, paidAt, total, { units: split.length }), split);
    };
    // Two sellers add up in a category; one order may span two categories.
    await oneOrder(sellerA, `2026-${M}-28T03:00:00Z`, [
      [meat, 30_000n],
      [bakery, 5_000n],
    ]);
    await oneOrder(sellerB, `2026-${M}-28T04:00:00Z`, [[meat, 20_000n]]);
    await oneOrder(sellerB, `2026-${M}-29T04:00:00Z`, [[dairy, 7_000n]]);
    await oneOrder(sellerA, `2026-${M}-30T03:00:00Z`, [[dairy, 900_000n]]); // outside the range
    // Goods whose category could not be read are kept under the nil UUID and rank like any other.
    await oneOrder(sellerB, `2026-${M}-29T05:00:00Z`, [[UNKNOWN_CATEGORY, 5_000n]]);
    await within(other, () =>
      recorder.recordSellerOrder(
        other,
        order(sellerA, `2026-${M}-28T03:00:00Z`, 5_000_000n, {}, CURRENCIES[otherMarketOf(code)]),
        [
          {
            categoryId: bakery,
            goods: { amount: 5_000_000n, tax: 5_000_000n / 11n },
            units: 1,
          },
        ],
      ),
    );

    const range = { from: day(`2026-${M}-28`), to: day(`2026-${M}-29`) };
    const readTop = async (rowCurrency: string, limit: number) => {
      const unit = await db.unitOfWork.run(
        market,
        async () => ok(await reader.topCategories(market, rowCurrency, range, limit)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    const top = await readTop(currency, 5);
    const tied = [bakery, UNKNOWN_CATEGORY].sort(); // equal sales: the lower id comes first
    expect(top.map((row) => [row.categoryId, row.salesAmount, row.orders])).toEqual([
      [meat, 50_000n, 2],
      [dairy, 7_000n, 1],
      ...tied.map((categoryId) => [categoryId, 5_000n, 1]),
    ]);
    expect((await readTop(currency, 1)).map((row) => row.categoryId)).toEqual([meat]);
    expect(await readTop('XXX', 5)).toEqual([]);
  });

  it('tallies the seller orders paid in the range by where they stand, refunded apart', async () => {
    // Months no other reporting spec uses, so the refunds of other specs fall outside the range.
    const N = code === TEST_MARKETS[0] ? '05' : '08';
    const a = idOf<'Seller'>();
    const b = idOf<'Seller'>();
    const paid = (seller: Id<'Seller'>, overrides: Partial<SellerOrderFact> = {}) =>
      order(seller, `2026-${N}-10T03:00:00Z`, 11_000n, overrides);
    const toShip = paid(a);
    const shipped = paid(a, { shippedAt: at(`2026-${N}-11T03:00:00Z`), shippedOnTime: true });
    const delivered = paid(b, {
      shippedAt: at(`2026-${N}-11T03:00:00Z`),
      shippedOnTime: true,
      deliveredAt: at(`2026-${N}-12T03:00:00Z`),
    });
    const refundedDelivered = paid(b, {
      shippedAt: at(`2026-${N}-11T03:00:00Z`),
      shippedOnTime: true,
      deliveredAt: at(`2026-${N}-12T03:00:00Z`),
    });
    const refundedToShip = paid(a);
    const cancelled = paid(a, { cancelledAt: at(`2026-${N}-10T05:00:00Z`) });
    const before = order(a, `2026-${N}-01T03:00:00Z`, 11_000n); // paid before the range
    for (const fact of [
      toShip,
      shipped,
      delivered,
      refundedDelivered,
      refundedToShip,
      cancelled,
      before,
    ]) {
      await record(market, fact);
    }
    const refund = (fact: SellerOrderFact, refundedAt: string) =>
      within(market, () =>
        recorder.recordRefund(
          market,
          {
            refundId: idOf<'Refund'>(),
            orderId: fact.orderId,
            sellerOrderId: fact.sellerOrderId,
            sellerId: fact.sellerId,
            currency,
            total: { amount: 1_100n, tax: 100n },
            shipping: { amount: 0n, tax: 0n },
            refundedAt: at(refundedAt),
          },
          [{ categoryId: UNKNOWN_CATEGORY, goods: { amount: 1_100n, tax: 100n }, units: 1 }],
        ),
      );
    await refund(refundedDelivered, `2026-${N}-13T03:00:00Z`);
    // Two refunds of one seller order count it once.
    await refund(refundedToShip, `2026-${N}-10T06:00:00Z`);
    await refund(refundedToShip, `2026-${N}-14T06:00:00Z`);
    // A refund of a seller order paid before the range, inside the range: not counted.
    await refund(before, `2026-${N}-11T06:00:00Z`);
    // A refund of a cancelled seller order: it stays cancelled.
    await refund(cancelled, `2026-${N}-10T07:00:00Z`);
    // The other Market's seller order on the same day is never read.
    await record(
      other,
      order(a, `2026-${N}-10T03:00:00Z`, 1_000n, {}, CURRENCIES[otherMarketOf(code)]),
    );

    const range = { from: day(`2026-${N}-05`), to: day(`2026-${N}-20`) };
    const read = async (target: MarketContext, rowCurrency: string) => {
      const unit = await db.unitOfWork.run(
        target,
        async () => ok(await reader.orderStatusTallies(target, rowCurrency, range)),
        { readOnly: true },
      );
      if (!unit.ok) throw new Error('read failed');
      return unit.value;
    };
    expect(await read(market, currency)).toEqual({
      paid: 6,
      cancelled: 1,
      delivered: 2,
      shipped: 1,
      refunded: { delivered: 1, shipped: 0, toShip: 1 },
    });
    expect(await read(market, 'XXX')).toEqual({
      paid: 0,
      cancelled: 0,
      delivered: 0,
      shipped: 0,
      refunded: { delivered: 0, shipped: 0, toShip: 0 },
    });
  });
});

import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import type { RefundFact, SellerOrderFact } from '../../src/modules/reporting/domain/facts';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Reporting's facts and daily rollups on PostgreSQL as the application role (dashboards upgrade
// phase 3, PR 9): a seller order counts on the day of each of its instants in the Market's zone,
// a refund on its own day as negative entries, a fact recorded again converges, a fact that moves
// to another day leaves nothing on the old one, another Market never sees the rows, the CHECKs hold
// the signs and the role cannot rewrite a fact's keys.

const ZONES: Record<string, string> = { AU: 'Australia/Brisbane', ZZ: 'Asia/Tokyo' };
const CURRENCIES: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
const DENIED = '42501';
const CHECK = '23514';
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const at = (text: string) => Temporal.Instant.from(text);

describe.each(TEST_MARKETS)('reporting facts and rollups in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let recorder: FactRecorder;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    const now = () => Temporal.Now.instant();
    recorder = new FactRecorder({
      facts: new PrismaFactStore(db.service, now),
      rollups: new PrismaRollupStore(db.service, now),
      zone: { zoneOf: (target: MarketContext) => ZONES[target.marketId] as string },
    });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
    await db.close();
  });

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()), { isolation: 'serializable' });

  const sellerDays = async (sellerId: string) =>
    (
      await owner.query<{
        market_id: string;
        day: string;
        currency: string;
        orders_paid: number;
        goods_amount: string;
        goods_tax_amount: string;
        orders_shipped: number;
        orders_shipped_on_time: number;
        refunds: number;
        refund_amount: string;
      }>(
        `SELECT market_id, to_char(market_day, 'YYYY-MM-DD') AS day, currency, orders_paid,
                goods_amount, goods_tax_amount, orders_shipped, orders_shipped_on_time, refunds,
                refund_amount
           FROM reporting.daily_seller_sales WHERE seller_id = $1 ORDER BY market_day`,
        [sellerId],
      )
    ).rows;
  const categoryDays = async (sellerId: string) =>
    (
      await owner.query<{
        day: string;
        category_id: string;
        orders: number;
        sales_amount: string;
        refund_amount: string;
        refund_units: number;
      }>(
        `SELECT to_char(market_day, 'YYYY-MM-DD') AS day, category_id, orders, sales_amount,
                refund_amount, refund_units
           FROM reporting.daily_category_sales WHERE seller_id = $1
          ORDER BY market_day, category_id`,
        [sellerId],
      )
    ).rows;

  const sellerOrder = (sellerId: Id<'Seller'>, overrides: Partial<SellerOrderFact> = {}) => ({
    sellerOrderId: idOf<'SellerOrder'>(),
    orderId: idOf<'Order'>(),
    sellerId,
    currency,
    goods: { amount: 2200n, tax: 200n },
    units: 2,
    shipping: { amount: 550n, tax: 50n },
    // 23:30 UTC on 21 Nov is 22 Nov in Brisbane and in Tokyo.
    paidAt: at('2026-11-21T23:30:00Z'),
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
    ...overrides,
  });

  it('records a paid seller order on its Market day, with its goods by category', async () => {
    const sellerId = idOf<'Seller'>();
    const food = idOf<'Category'>();
    const drink = idOf<'Category'>();
    const order = sellerOrder(sellerId);
    await within(market, () =>
      recorder.recordSellerOrder(market, order, [
        { categoryId: food, goods: { amount: 1100n, tax: 100n }, units: 1 },
        { categoryId: drink, goods: { amount: 1100n, tax: 100n }, units: 1 },
      ]),
    );

    expect(await sellerDays(sellerId)).toEqual([
      expect.objectContaining({
        market_id: code,
        day: '2026-11-22',
        currency,
        orders_paid: 1,
        goods_amount: '2200',
        goods_tax_amount: '200',
      }),
    ]);
    expect((await categoryDays(sellerId)).map((row) => [row.orders, row.sales_amount])).toEqual([
      [1, '1100'],
      [1, '1100'],
    ]);
  });

  it('converges when recorded again, and leaves nothing on a day a fact moved away from', async () => {
    const sellerId = idOf<'Seller'>();
    const category = idOf<'Category'>();
    const goods = [{ categoryId: category, goods: { amount: 2200n, tax: 200n }, units: 2 }];
    const order = sellerOrder(sellerId);
    await within(market, () => recorder.recordSellerOrder(market, order, goods));
    await within(market, () => recorder.recordSellerOrder(market, order, goods));
    expect(await sellerDays(sellerId)).toHaveLength(1);

    // The owner's state now says it was paid two days later and shipped on time on 25 Nov.
    const moved = {
      ...order,
      paidAt: at('2026-11-23T03:00:00Z'),
      shippedAt: at('2026-11-25T03:00:00Z'),
      shippedOnTime: true,
    };
    await within(market, () => recorder.recordSellerOrder(market, moved, goods));

    expect(
      (await sellerDays(sellerId)).map((row) => [
        row.day,
        row.orders_paid,
        row.orders_shipped,
        row.orders_shipped_on_time,
      ]),
    ).toEqual([
      ['2026-11-23', 1, 0, 0],
      ['2026-11-25', 0, 1, 1],
    ]);
    expect((await categoryDays(sellerId)).map((row) => row.day)).toEqual(['2026-11-23']);
  });

  it('records a refund on its own day as negative goods, leaving the order day as it was', async () => {
    const sellerId = idOf<'Seller'>();
    const category = idOf<'Category'>();
    const order = sellerOrder(sellerId);
    await within(market, () =>
      recorder.recordSellerOrder(market, order, [
        { categoryId: category, goods: { amount: 2200n, tax: 200n }, units: 2 },
      ]),
    );
    const refund: RefundFact = {
      refundId: idOf<'Refund'>(),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId,
      currency,
      total: { amount: 1650n, tax: 150n },
      shipping: { amount: 550n, tax: 50n },
      refundedAt: at('2026-11-26T01:00:00Z'),
    };
    const goods = [{ categoryId: category, goods: { amount: 1100n, tax: 100n }, units: 1 }];
    await within(market, () => recorder.recordRefund(market, refund, goods));
    await within(market, () => recorder.recordRefund(market, refund, goods));

    expect(
      (await sellerDays(sellerId)).map((row) => [
        row.day,
        row.orders_paid,
        row.goods_amount,
        row.refunds,
        row.refund_amount,
      ]),
    ).toEqual([
      ['2026-11-22', 1, '2200', 0, '0'],
      ['2026-11-26', 0, '0', 1, '1650'],
    ]);
    expect(
      (await categoryDays(sellerId)).map((row) => [
        row.day,
        row.sales_amount,
        row.refund_amount,
        row.refund_units,
      ]),
    ).toEqual([
      ['2026-11-22', '2200', '0', 0],
      ['2026-11-26', '0', '-1100', -1],
    ]);
  });

  it('keeps every row in its Market', async () => {
    const sellerId = idOf<'Seller'>();
    await within(market, () => recorder.recordSellerOrder(market, sellerOrder(sellerId), []));
    const seen = await within(other, () =>
      db.service
        .tx(other)
        .reportingDailySellerSales.findMany({ where: { marketId: other.marketId, sellerId } }),
    );
    expect(seen.ok && seen.value).toEqual([]);
    expect((await sellerDays(sellerId)).map((row) => row.market_id)).toEqual([code]);
  });

  it('refuses a refund entry with a positive amount (CHECK)', async () => {
    await expect(
      owner.query(
        `INSERT INTO reporting.sales_entries (market_id, tenant_id, kind, source_id, category_id,
           order_id, seller_order_id, seller_id, currency, market_day, amount, tax_amount, units,
           recorded_at)
         VALUES ($1, $2, 'refund', $3, $3, $3, $3, $3, $4, '2026-11-22', 10, 0, -1, now())`,
        [market.marketId, market.tenantId, idOf(), currency],
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('lets the application role rewrite the measures of a fact but never its keys', async () => {
    const sellerId = idOf<'Seller'>();
    const order = sellerOrder(sellerId);
    await within(market, () => recorder.recordSellerOrder(market, order, []));
    await expect(
      app.query(`UPDATE reporting.seller_orders SET seller_id = $1 WHERE seller_order_id = $2`, [
        idOf(),
        order.sellerOrderId,
      ]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      app.query(`DELETE FROM reporting.seller_orders WHERE seller_order_id = $1`, [
        order.sellerOrderId,
      ]),
    ).rejects.toMatchObject({ code: DENIED });
  });
});

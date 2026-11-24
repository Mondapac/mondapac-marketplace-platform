import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import { ReportingFactConflict } from '../../src/modules/reporting/application/ports/fact-store';
import {
  UNKNOWN_CATEGORY,
  type RefundFact,
  type SellerOrderFact,
} from '../../src/modules/reporting/domain/facts';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { reportingFactsOwnerTestDatabaseUrl, reportingFactsTestDatabaseUrl } from './test-database';

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
    db = createPersistence({ databaseUrl: reportingFactsTestDatabaseUrl() });
    owner = new Client({ connectionString: reportingFactsOwnerTestDatabaseUrl() });
    app = new Client({ connectionString: reportingFactsTestDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    const now = () => Temporal.Now.instant();
    recorder = new FactRecorder({
      facts: new PrismaFactStore(db.service, now),
      rollups: new PrismaRollupStore(db.service, now),
      zone: {
        zoneOf: (target: MarketContext) => ZONES[target.marketId] as string,
        currencyOf: (target: MarketContext) => CURRENCIES[target.marketId] as string,
      },
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
        refund_goods_amount: string;
        refund_shipping_amount: string;
      }>(
        `SELECT market_id, to_char(market_day, 'YYYY-MM-DD') AS day, currency, orders_paid,
                goods_amount, goods_tax_amount, orders_shipped, orders_shipped_on_time, refunds,
                refund_goods_amount, refund_shipping_amount
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

  const sellerOrder = (
    sellerId: Id<'Seller'>,
    overrides: Partial<SellerOrderFact> = {},
  ): SellerOrderFact => ({
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
    delivery: { method: 'instant', state: null },
    buyerFirst: { order: null, withSeller: null },
    ...overrides,
  });

  const allGoods = (order: SellerOrderFact) => [
    { categoryId: UNKNOWN_CATEGORY, goods: order.goods, units: order.units },
  ];

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
        row.refund_goods_amount,
        row.refund_shipping_amount,
      ]),
    ).toEqual([
      ['2026-11-22', 1, '2200', 0, '0', '0'],
      ['2026-11-26', 0, '0', 1, '-1100', '-550'],
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
    const order = sellerOrder(sellerId);
    await within(market, () => recorder.recordSellerOrder(market, order, allGoods(order)));
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
    await within(market, () => recorder.recordSellerOrder(market, order, allGoods(order)));
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

  it('refuses a fact that names another seller or currency, and goods that do not add up', async () => {
    const sellerId = idOf<'Seller'>();
    const order = sellerOrder(sellerId);
    await within(market, () => recorder.recordSellerOrder(market, order, allGoods(order)));

    const moved = { ...order, sellerId: idOf<'Seller'>() };
    await expect(
      within(market, () => recorder.recordSellerOrder(market, moved, allGoods(moved))),
    ).rejects.toThrow(ReportingFactConflict);
    const refund: RefundFact = {
      refundId: idOf<'Refund'>(),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId: idOf<'Seller'>(),
      currency,
      total: { amount: 1100n, tax: 100n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: at('2026-11-26T01:00:00Z'),
    };
    const refundGoods = [{ categoryId: UNKNOWN_CATEGORY, goods: refund.total, units: 1 }];
    await expect(
      within(market, () => recorder.recordRefund(market, refund, refundGoods)),
    ).rejects.toThrow(ReportingFactConflict);
    await expect(
      within(market, () => recorder.recordSellerOrder(market, { ...order, currency: 'NZD' }, [])),
    ).rejects.toThrow(RangeError);
    await expect(
      within(market, () => recorder.recordSellerOrder(market, order, [])),
    ).rejects.toThrow(RangeError);

    // Nothing moved: the first seller still holds its day.
    expect((await sellerDays(sellerId)).map((row) => row.orders_paid)).toEqual([1]);
    expect(await sellerDays(moved.sellerId)).toEqual([]);
  });

  it('refuses a seller order that differs from a refund recorded before it', async () => {
    const sellerId = idOf<'Seller'>();
    const order = sellerOrder(sellerId);
    const early: RefundFact = {
      refundId: idOf<'Refund'>(),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId: idOf<'Seller'>(),
      currency,
      total: { amount: 1100n, tax: 100n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: at('2026-11-26T01:00:00Z'),
    };
    await within(market, () =>
      recorder.recordRefund(market, early, [
        { categoryId: UNKNOWN_CATEGORY, goods: early.total, units: 1 },
      ]),
    );
    await expect(
      within(market, () => recorder.recordSellerOrder(market, order, allGoods(order))),
    ).rejects.toThrow(ReportingFactConflict);
    expect(await sellerDays(sellerId)).toEqual([]);
  });

  describe('delivery method and state (dashboards v2)', () => {
    // A region of this Market's `shipping.postcodeRegions` (AU QLD, ZZ ZA).
    const state = code === 'AU' ? 'QLD' : 'ZA';
    const deliveryOf = async (sellerOrderId: string) =>
      (
        await owner.query<{ method: string | null; state: string | null }>(
          `SELECT delivery_method AS method, delivery_state AS state
             FROM reporting.seller_orders WHERE seller_order_id = $1`,
          [sellerOrderId],
        )
      ).rows;

    it('records a delivery and a pickup with their state, again idempotently, outside the rollups', async () => {
      const sellerId = idOf<'Seller'>();
      const delivered = sellerOrder(sellerId, { delivery: { method: 'same_day', state } });
      const pickup = sellerOrder(sellerId, { delivery: { method: 'pickup', state } });
      for (let round = 0; round < 2; round += 1) {
        await within(market, () =>
          recorder.recordBatch(market, {
            sellerOrders: [delivered, pickup].map((order) => ({ order, goods: allGoods(order) })),
            refunds: [],
          }),
        );
      }
      expect(await deliveryOf(delivered.sellerOrderId)).toEqual([{ method: 'same_day', state }]);
      expect(await deliveryOf(pickup.sellerOrderId)).toEqual([{ method: 'pickup', state }]);
      // Not a rollup key: one seller day, both orders in it.
      expect((await sellerDays(sellerId)).map((row) => row.orders_paid)).toEqual([2]);
    });

    it('keeps an unknown state null and a known state as first recorded', async () => {
      const sellerId = idOf<'Seller'>();
      const unknown = sellerOrder(sellerId, { delivery: { method: 'instant', state: null } });
      await within(market, () => recorder.recordSellerOrder(market, unknown, allGoods(unknown)));
      expect(await deliveryOf(unknown.sellerOrderId)).toEqual([{ method: 'instant', state: null }]);

      const known = sellerOrder(sellerId, { delivery: { method: 'pickup', state } });
      await within(market, () => recorder.recordSellerOrder(market, known, allGoods(known)));
      // A later read no longer knows it (a removed quote), or gives another (the store moved).
      const later = code === 'AU' ? 'NSW' : 'ZB';
      for (const read of [null, later]) {
        const again = { ...known, delivery: { method: 'pickup' as const, state: read } };
        await within(market, () => recorder.recordSellerOrder(market, again, allGoods(again)));
        expect(await deliveryOf(known.sellerOrderId)).toEqual([{ method: 'pickup', state }]);
      }
    });

    it('refuses a malformed state in the recorder and in the CHECK, and lets the role write both', async () => {
      const sellerId = idOf<'Seller'>();
      const bad = sellerOrder(sellerId, { delivery: { method: 'instant', state: '4000' } });
      await expect(
        within(market, () => recorder.recordSellerOrder(market, bad, allGoods(bad))),
      ).rejects.toThrow(RangeError);
      const order = sellerOrder(sellerId);
      await within(market, () => recorder.recordSellerOrder(market, order, allGoods(order)));
      for (const [method, value] of [
        ['instant', 'q1'],
        ['instant', 'Q-1'],
        ['courier', null],
        [null, state],
      ] as const) {
        await expect(
          owner.query(
            `UPDATE reporting.seller_orders SET delivery_method = $1, delivery_state = $2
              WHERE seller_order_id = $3`,
            [method, value, order.sellerOrderId],
          ),
        ).rejects.toMatchObject({ code: CHECK });
      }
      const updated = await app.query(
        `UPDATE reporting.seller_orders SET delivery_method = 'scheduled', delivery_state = $1
          WHERE seller_order_id = $2`,
        [state, order.sellerOrderId],
      );
      expect(updated.rowCount).toBe(1);
      expect(await deliveryOf(order.sellerOrderId)).toEqual([{ method: 'scheduled', state }]);
    });
  });

  describe('buyer-first flags (dashboards v2)', () => {
    const FIRST = { order: true, withSeller: true };
    const RETURNING = { order: false, withSeller: false };
    const NEW_TO_SELLER = { order: false, withSeller: true };
    const UNKNOWN = { order: null, withSeller: null };
    const flagsOf = async (sellerOrderId: string) =>
      (
        await owner.query<{ order: boolean | null; withSeller: boolean | null }>(
          `SELECT buyer_first_order AS "order", buyer_first_with_seller AS "withSeller"
             FROM reporting.seller_orders WHERE seller_order_id = $1`,
          [sellerOrderId],
        )
      ).rows;
    const record = (order: SellerOrderFact) =>
      within(market, () => recorder.recordSellerOrder(market, order, allGoods(order)));

    it('stores the two flags as ordering reports them, outside the rollups', async () => {
      const sellerId = idOf<'Seller'>();
      const facts = [FIRST, RETURNING, NEW_TO_SELLER].map((buyerFirst) =>
        sellerOrder(sellerId, { buyerFirst }),
      );
      for (const fact of facts) await record(fact);
      expect(await flagsOf(facts[0]!.sellerOrderId)).toEqual([FIRST]);
      expect(await flagsOf(facts[1]!.sellerOrderId)).toEqual([RETURNING]);
      expect(await flagsOf(facts[2]!.sellerOrderId)).toEqual([NEW_TO_SELLER]);
      // Not a rollup key: one seller day, the three orders in it.
      expect((await sellerDays(sellerId)).map((row) => row.orders_paid)).toEqual([3]);
    });

    it('keeps unknown flags null, fills them once known, and never changes a known flag', async () => {
      const sellerId = idOf<'Seller'>();
      const unpaid = sellerOrder(sellerId, { paidAt: null });
      await record(unpaid);
      expect(await flagsOf(unpaid.sellerOrderId)).toEqual([UNKNOWN]);

      // Paid before ordering recorded them: unknown, and stays so on a second read.
      const legacy = sellerOrder(sellerId);
      await record(legacy);
      await record(legacy);
      expect(await flagsOf(legacy.sellerOrderId)).toEqual([UNKNOWN]);

      // Paid later: the worker writes the flags with the payment.
      await record({ ...unpaid, paidAt: at('2026-11-22T01:00:00Z'), buyerFirst: NEW_TO_SELLER });
      expect(await flagsOf(unpaid.sellerOrderId)).toEqual([NEW_TO_SELLER]);

      // A later read that no longer knows them, or says otherwise, leaves the first record.
      const known = sellerOrder(sellerId, { buyerFirst: FIRST });
      await record(known);
      for (const buyerFirst of [UNKNOWN, RETURNING, NEW_TO_SELLER]) {
        await record({ ...known, buyerFirst });
        expect(await flagsOf(known.sellerOrderId)).toEqual([FIRST]);
      }
    });

    it('refuses contradictory flags in the recorder and in the CHECK, and lets the role write both', async () => {
      const sellerId = idOf<'Seller'>();
      for (const bad of [
        sellerOrder(sellerId, { buyerFirst: { order: true, withSeller: null } }),
        sellerOrder(sellerId, { buyerFirst: { order: true, withSeller: false } }),
        sellerOrder(sellerId, { paidAt: null, buyerFirst: RETURNING }),
      ]) {
        await expect(record(bad)).rejects.toThrow(RangeError);
      }
      const order = sellerOrder(sellerId);
      await record(order);
      for (const [first, withSeller] of [
        [true, null],
        [null, false],
        [true, false],
      ] as const) {
        await expect(
          owner.query(
            `UPDATE reporting.seller_orders
                SET buyer_first_order = $1, buyer_first_with_seller = $2
              WHERE seller_order_id = $3`,
            [first, withSeller, order.sellerOrderId],
          ),
        ).rejects.toMatchObject({ code: CHECK });
      }
      const unpaid = sellerOrder(sellerId, { paidAt: null });
      await record(unpaid);
      await expect(
        owner.query(
          `UPDATE reporting.seller_orders SET buyer_first_order = false, buyer_first_with_seller = false
            WHERE seller_order_id = $1`,
          [unpaid.sellerOrderId],
        ),
      ).rejects.toMatchObject({ code: CHECK });
      const updated = await app.query(
        `UPDATE reporting.seller_orders SET buyer_first_order = false, buyer_first_with_seller = true
          WHERE seller_order_id = $1`,
        [order.sellerOrderId],
      );
      expect(updated.rowCount).toBe(1);
      expect(await flagsOf(order.sellerOrderId)).toEqual([NEW_TO_SELLER]);
    });

    it('holds no customer or account id anywhere in reporting', async () => {
      const columns = await owner.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'reporting'
            AND (column_name ~ '(account|customer|buyer|shopper)' AND column_name !~ '^buyer_first_')`,
      );
      expect(columns.rows).toEqual([]);
    });
  });
});

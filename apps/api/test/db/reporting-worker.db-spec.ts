import { err, ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FactRecorder } from '../../src/modules/reporting/application/fact-recorder';
import type {
  ReportSources,
  SellerOrderSourceRef,
  SourceWindow,
} from '../../src/modules/reporting/application/ports/report-sources';
import {
  reconcileWindow,
  type ReportFactsDependencies,
} from '../../src/modules/reporting/application/report-facts-sync';
import {
  refundSource,
  sellerOrderSource,
} from '../../src/modules/reporting/infrastructure/facade-report-sources';
import { PrismaFactStore } from '../../src/modules/reporting/infrastructure/prisma-fact-store';
import { PrismaRollupStore } from '../../src/modules/reporting/infrastructure/prisma-rollup-store';
import type {
  RefundReportFacts,
  SellerOrderReportFacts,
} from '../../src/modules/ordering/contracts/ordering-reporting.facade';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Reporting's nightly reconcile on PostgreSQL (dashboards upgrade phase 3, PR 10b), for both
// Market fixtures, with the owners faked at the facade's shape: every page of changes is read and
// recorded in serializable units, a never-paid seller order is not recorded, an Offer catalog
// cannot place counts in the unknown category, a second run converges, a refund refused by the
// recorder fails its page only, and another Market's rows stay apart.

const ZONES: Record<string, string> = { AU: 'Australia/Brisbane', ZZ: 'Asia/Tokyo' };
const CURRENCIES: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
const UNKNOWN = '00000000-0000-0000-0000-000000000000';
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const T0 = Temporal.Instant.from('2026-11-20T02:00:00Z');

/** Ordering and catalog as a list: the changes are every fact, paged by seller order id. */
class FakeOwners implements ReportSources {
  orders: SellerOrderReportFacts[] = [];
  refundFacts: RefundReportFacts[] = [];
  categories = new Map<Id<'Offer'>, Id<'Category'>>();
  reads = 0;

  sellerOrders(_context: CallContext, refs: readonly SellerOrderSourceRef[]) {
    this.reads += 1;
    const wanted = new Set(refs.map((ref) => ref.sellerOrderId));
    return Promise.resolve(
      ok(
        this.orders
          .filter((order) => wanted.has(order.sellerOrderId))
          .map((order) => sellerOrderSource(order, this.categories)),
      ),
    );
  }
  refunds(_context: CallContext, ids: readonly string[]) {
    const wanted = new Set(ids);
    return Promise.resolve(
      ok(
        this.refundFacts
          .filter((refund) => wanted.has(refund.refundId))
          .map((refund) => refundSource(refund, this.categories)),
      ),
    );
  }
  changedSellerOrders(_c: CallContext, _w: SourceWindow, after: string | null, limit: number) {
    const sorted = this.orders
      .map((order) => ({ orderId: order.orderId, sellerOrderId: order.sellerOrderId }))
      .sort((a, b) => (a.sellerOrderId < b.sellerOrderId ? -1 : 1))
      .filter((ref) => after === null || ref.sellerOrderId > after);
    const items = sorted.slice(0, limit);
    return Promise.resolve(
      ok({ items, next: sorted.length > limit ? items[items.length - 1]!.sellerOrderId : null }),
    );
  }
  succeededRefunds(_c: CallContext, _w: SourceWindow, after: string | null, limit: number) {
    const sorted = this.refundFacts
      .map((refund) => refund.refundId as string)
      .sort()
      .filter((id) => after === null || id > after);
    const items = sorted.slice(0, limit);
    return Promise.resolve(
      ok({ items, next: sorted.length > limit ? items[items.length - 1]! : null }),
    );
  }
}

/** The fake's methods bound, so one can be replaced. */
const sourcesOf = (owners: FakeOwners): ReportSources => ({
  sellerOrders: (context, refs) => owners.sellerOrders(context, refs),
  refunds: (context, ids) => owners.refunds(context, ids),
  changedSellerOrders: (context, window, after, limit) =>
    owners.changedSellerOrders(context, window, after, limit),
  succeededRefunds: (context, window, after, limit) =>
    owners.succeededRefunds(context, window, after, limit),
});

describe.each(TEST_MARKETS)('reporting reconcile in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let owner: Client;
  let owners: FakeOwners;
  let deps: ReportFactsDependencies;
  const clock = new FixedClock(T0);
  const system = (target: MarketContext = market) => testCallContext(target, 'system');

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  beforeEach(() => {
    owners = new FakeOwners();
    const now = () => Temporal.Now.instant();
    deps = {
      unitOfWork: db.unitOfWork,
      sources: owners,
      clock,
      recorder: new FactRecorder({
        facts: new PrismaFactStore(db.service, now),
        rollups: new PrismaRollupStore(db.service, now),
        zone: {
          zoneOf: (target: MarketContext) => ZONES[target.marketId] as string,
          currencyOf: (target: MarketContext) => CURRENCIES[target.marketId] as string,
        },
      }),
    };
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const window = { from: T0.subtract({ hours: 168 }), to: T0 };
  const sellerOrder = (
    sellerId: Id<'Seller'>,
    offerId: Id<'Offer'>,
    paidAt: Temporal.Instant | null,
  ): SellerOrderReportFacts => ({
    orderId: idOf<'Order'>(),
    sellerOrderId: idOf<'SellerOrder'>(),
    sellerId,
    currency,
    lines: [{ offerId, quantity: 2, goods: { amount: 2200n, tax: 200n } }],
    shipping: { amount: 550n, tax: 50n },
    paidAt,
    cancelledAt: null,
    shippedAt: null,
    shippedOnTime: null,
    deliveredAt: null,
  });
  const days = async (sellerId: string) =>
    (
      await owner.query<{ market_id: string; orders_paid: number; goods_amount: string }>(
        `SELECT market_id, orders_paid, goods_amount FROM reporting.daily_seller_sales
          WHERE seller_id = $1 ORDER BY market_day`,
        [sellerId],
      )
    ).rows;
  const categories = async (sellerId: string) =>
    (
      await owner.query<{ category_id: string; sales_amount: string; refund_amount: string }>(
        `SELECT category_id, sales_amount, refund_amount FROM reporting.daily_category_sales
          WHERE seller_id = $1 ORDER BY category_id`,
        [sellerId],
      )
    ).rows;

  it('records every page of the window, skips a never-paid order and converges on a second run', async () => {
    const sellerId = idOf<'Seller'>();
    const known = idOf<'Offer'>();
    const category = idOf<'Category'>();
    owners.categories.set(known, category);
    // 150 paid seller orders: two pages of 100.
    for (let i = 0; i < 150; i += 1)
      owners.orders.push(sellerOrder(sellerId, known, T0.subtract({ hours: 1 })));
    owners.orders.push(sellerOrder(sellerId, known, null));
    const first = await reconcileWindow(deps, system(), window);
    expect(first).toEqual(ok({ sellerOrders: 150, refunds: 0, failedBatches: 0 }));
    expect(owners.reads).toBe(2);
    const again = await reconcileWindow(deps, system(), window);
    expect(again.ok && again.value.failedBatches).toBe(0);
    expect(await days(sellerId)).toEqual([
      { market_id: market.marketId, orders_paid: 150, goods_amount: String(150n * 2200n) },
    ]);
    const stored = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM reporting.seller_orders WHERE seller_id = $1',
      [sellerId],
    );
    expect(stored.rows[0]?.n).toBe('150');
    expect(
      (
        await owner.query(
          'SELECT 1 FROM reporting.daily_seller_sales WHERE seller_id = $1 AND market_id = $2',
          [sellerId, other.marketId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('places an unknown Offer in the unknown category and a refund on its own day, negative', async () => {
    const sellerId = idOf<'Seller'>();
    const order = sellerOrder(sellerId, idOf<'Offer'>(), T0.subtract({ hours: 30 }));
    owners.orders.push(order);
    owners.refundFacts.push({
      refundId: idOf<'Refund'>(),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId,
      currency,
      total: { amount: 1100n, tax: 100n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: T0.subtract({ hours: 1 }),
      lines: [
        { offerId: order.lines[0]!.offerId, quantity: 1, goods: { amount: 1100n, tax: 100n } },
      ],
    });
    const done = await reconcileWindow(deps, system(), window);
    expect(done).toEqual(ok({ sellerOrders: 1, refunds: 1, failedBatches: 0 }));
    const rows = await categories(sellerId);
    expect(rows.map((row) => row.category_id)).toEqual([UNKNOWN, UNKNOWN]);
    expect(rows.map((row) => [row.sales_amount, row.refund_amount]).sort()).toEqual(
      [
        ['0', '-1100'],
        ['2200', '0'],
      ].sort(),
    );
  });

  it('fails only the batch of a fact the recorder refuses, and stops on a failed read', async () => {
    const sellerId = idOf<'Seller'>();
    const good = sellerOrder(sellerId, idOf<'Offer'>(), T0.subtract({ hours: 2 }));
    owners.orders.push(good);
    owners.refundFacts.push({
      refundId: idOf<'Refund'>(),
      orderId: good.orderId,
      sellerOrderId: good.sellerOrderId,
      sellerId,
      currency: currency === 'AUD' ? 'JPY' : 'AUD',
      total: { amount: 100n, tax: 0n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: T0.subtract({ hours: 1 }),
      lines: [],
    });
    const done = await reconcileWindow(deps, system(), window);
    expect(done).toEqual(ok({ sellerOrders: 1, refunds: 0, failedBatches: 1 }));
    expect((await days(sellerId)).map((row) => row.orders_paid)).toEqual([1]);

    const down: ReportSources['sellerOrders'] = () =>
      Promise.resolve(err({ code: 'reporting.source-unavailable', cause: 'down' }));
    deps = { ...deps, sources: { ...sourcesOf(owners), sellerOrders: down } };
    const stopped = await reconcileWindow(deps, system(), window);
    expect(!stopped.ok && stopped.error.code).toBe('reporting.source-unavailable');
  });
});

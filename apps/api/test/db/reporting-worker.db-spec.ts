import { err, ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  backfillHistory,
  type BackfillDependencies,
} from '../../src/modules/reporting/application/backfill-history';
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
import { PrismaBackfillProgressStore } from '../../src/modules/reporting/infrastructure/prisma-backfill-progress-store';
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
// recorder fails its page only, and another Market's rows stay apart. The history backfill (PR 12)
// goes on from its saved cursor run after run, keeps its window end, and a failed read or an
// overtaken cursor moves nothing.

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
    expect(first).toEqual(ok({ sellerOrders: 150, refunds: 0, failedFacts: 0 }));
    expect(owners.reads).toBe(2);
    const again = await reconcileWindow(deps, system(), window);
    expect(again.ok && again.value.failedFacts).toBe(0);
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
    expect(done).toEqual(ok({ sellerOrders: 1, refunds: 1, failedFacts: 0 }));
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
    // A good refund in the same batch is still written: the batch is retried one fact at a time.
    const kept = idOf<'Refund'>();
    owners.refundFacts.push({
      refundId: kept,
      orderId: good.orderId,
      sellerOrderId: good.sellerOrderId,
      sellerId,
      currency,
      total: { amount: 1100n, tax: 100n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: T0.subtract({ hours: 1 }),
      lines: [
        { offerId: good.lines[0]!.offerId, quantity: 1, goods: { amount: 1100n, tax: 100n } },
      ],
    });
    // Lines that cover more than the refund's goods are refused, not trimmed.
    owners.refundFacts.push({
      refundId: idOf<'Refund'>(),
      orderId: good.orderId,
      sellerOrderId: good.sellerOrderId,
      sellerId,
      currency,
      total: { amount: 500n, tax: 0n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: T0.subtract({ hours: 1 }),
      lines: [
        { offerId: good.lines[0]!.offerId, quantity: 1, goods: { amount: 1100n, tax: 100n } },
      ],
    });
    const done = await reconcileWindow(deps, system(), window);
    expect(done).toEqual(ok({ sellerOrders: 1, refunds: 1, failedFacts: 2 }));
    expect((await days(sellerId)).map((row) => row.orders_paid)).toEqual([1]);
    const stored = await owner.query<{ refund_id: string }>(
      'SELECT refund_id FROM reporting.refunds WHERE seller_order_id = $1',
      [good.sellerOrderId],
    );
    expect(stored.rows.map((row) => row.refund_id)).toEqual([kept]);

    const down: ReportSources['sellerOrders'] = () =>
      Promise.resolve(err({ code: 'reporting.source-unavailable', cause: 'down' }));
    deps = { ...deps, sources: { ...sourcesOf(owners), sellerOrders: down } };
    const stopped = await reconcileWindow(deps, system(), window);
    expect(!stopped.ok && stopped.error.code).toBe('reporting.source-unavailable');

    // A cursor that does not move on stops the run instead of looping.
    const looping: ReportSources['changedSellerOrders'] = () =>
      Promise.resolve(ok({ items: [], next: good.sellerOrderId }));
    deps = { ...deps, sources: { ...sourcesOf(owners), changedSellerOrders: looping } };
    const loop = await reconcileWindow(deps, system(), window);
    expect(!loop.ok && loop.error.code).toBe('reporting.source-unavailable');
  });

  it('keeps what a newer fact recorded when an older read is written after it', async () => {
    const sellerId = idOf<'Seller'>();
    const paid = sellerOrder(sellerId, idOf<'Offer'>(), T0.subtract({ hours: 5 }));
    const shippedAt = T0.subtract({ hours: 2 });
    owners.orders.push({ ...paid, shippedAt, shippedOnTime: true });
    await reconcileWindow(deps, system(), window);
    // The paid event's read, taken before the shipment, is written last.
    owners.orders = [paid];
    await reconcileWindow(deps, system(), window);
    const row = await owner.query<{ shipped: boolean; on_time: boolean | null }>(
      `SELECT shipped_at IS NOT NULL AS shipped, shipped_on_time AS on_time
         FROM reporting.seller_orders WHERE seller_order_id = $1`,
      [paid.sellerOrderId],
    );
    expect(row.rows).toEqual([{ shipped: true, on_time: true }]);
    const shippedDays = await owner.query<{ n: number }>(
      'SELECT orders_shipped AS n FROM reporting.daily_seller_sales WHERE seller_id = $1 AND orders_shipped > 0',
      [sellerId],
    );
    expect(shippedDays.rows).toEqual([{ n: 1 }]);
  });

  describe('history backfill', () => {
    let backfill: BackfillDependencies;
    let windows: SourceWindow[];
    const progressOf = async () =>
      (
        await owner.query<{ kind: string; after: string | null; pages: number; done: boolean }>(
          `SELECT kind, after::text AS after, pages, finished_at IS NOT NULL AS done
             FROM reporting.backfill_progress WHERE market_id = $1 ORDER BY kind DESC`,
          [market.marketId],
        )
      ).rows;
    const idsOf = <T>(items: readonly T[], key: (item: T) => string) => items.map(key).sort();

    beforeEach(async () => {
      // Both Markets, so the other Market's progress is known to be untouched by this one's runs.
      await owner.query('DELETE FROM reporting.backfill_progress WHERE market_id = ANY($1)', [
        [market.marketId, other.marketId],
      ]);
      windows = [];
      const sources = sourcesOf(owners);
      backfill = {
        ...deps,
        sources: {
          ...sources,
          changedSellerOrders: (context, window, after, limit) => {
            windows.push(window);
            return sources.changedSellerOrders(context, window, after, limit);
          },
        },
        progress: new PrismaBackfillProgressStore(db.service, () => Temporal.Now.instant()),
      };
    });

    it('goes on from the saved cursor run after run, up to the instant it started', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 250; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 24 * (400 - i) })));
      for (const order of owners.orders.slice(0, 120)) {
        owners.refundFacts.push({
          refundId: idOf<'Refund'>(),
          orderId: order.orderId,
          sellerOrderId: order.sellerOrderId,
          sellerId,
          currency,
          total: { amount: 1100n, tax: 100n },
          shipping: { amount: 0n, tax: 0n },
          refundedAt: T0.subtract({ hours: 240 }),
          lines: [{ offerId: offer, quantity: 1, goods: { amount: 1100n, tax: 100n } }],
        });
      }
      const orderIds = idsOf(owners.orders, (order) => order.sellerOrderId);

      const first = await backfillHistory(backfill, system(), 2);
      expect(first).toEqual(
        ok({ sellerOrders: 200, refunds: 0, failedFacts: 0, pages: 2, finished: false }),
      );
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: orderIds[199], pages: 2, done: false },
      ]);

      // A later run keeps the window end fixed at the first start.
      const later = new FixedClock(T0.add({ hours: 3 }));
      backfill = { ...backfill, clock: later };
      const second = await backfillHistory(backfill, system(), 2);
      expect(second).toEqual(
        ok({ sellerOrders: 50, refunds: 100, failedFacts: 0, pages: 2, finished: false }),
      );
      const third = await backfillHistory(backfill, system(), 2);
      expect(third).toEqual(
        ok({ sellerOrders: 0, refunds: 20, failedFacts: 0, pages: 1, finished: true }),
      );
      expect(windows.every((window) => window.from === null && window.to.equals(T0))).toBe(true);
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: orderIds[199], pages: 3, done: true },
        {
          kind: 'refunds',
          after: idsOf(owners.refundFacts, (refund) => refund.refundId)[99],
          pages: 2,
          done: true,
        },
      ]);
      const stored = await owner.query<{ orders: string; refunds: string }>(
        `SELECT (SELECT count(*) FROM reporting.seller_orders WHERE seller_id = $1) AS orders,
                (SELECT count(*) FROM reporting.refunds WHERE seller_id = $1) AS refunds`,
        [sellerId],
      );
      expect(stored.rows).toEqual([{ orders: '250', refunds: '120' }]);

      // Finished: a run reads nothing more.
      const reads = owners.reads;
      const idle = await backfillHistory(backfill, system(), 2);
      expect(idle).toEqual(
        ok({ sellerOrders: 0, refunds: 0, failedFacts: 0, pages: 0, finished: true }),
      );
      expect(owners.reads).toBe(reads);
      expect(
        (
          await owner.query('SELECT 1 FROM reporting.backfill_progress WHERE market_id = $1', [
            other.marketId,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it('keeps the cursor where it was when a read fails, and an overtaken cursor moves nothing', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 150; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 720 })));
      const down: ReportSources['sellerOrders'] = () =>
        Promise.resolve(err({ code: 'reporting.source-unavailable', cause: 'down' }));
      const failing = { ...backfill, sources: { ...backfill.sources, sellerOrders: down } };
      const stopped = await backfillHistory(failing, system(), 5);
      expect(!stopped.ok && stopped.error.code).toBe('reporting.source-unavailable');
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: null, pages: 0, done: false },
      ]);

      // Another run moved the cursor on meanwhile: a late run's step from the old place is refused.
      const started = await db.unitOfWork.run(market, async () =>
        ok(await backfill.progress.start(market, 'seller-orders', T0)),
      );
      if (!started.ok) throw new Error('start');
      const step = {
        after: owners.orders[0]!.sellerOrderId,
        pages: 1,
        failedFacts: 0,
        finished: false,
      };
      const moved = await db.unitOfWork.run(market, async () =>
        ok(await backfill.progress.advance(market, started.value, step)),
      );
      expect(moved.ok && moved.value?.pages).toBe(1);
      const late = await db.unitOfWork.run(market, async () =>
        ok(await backfill.progress.advance(market, started.value, step)),
      );
      expect(late).toEqual(ok(null));

      const resumed = await backfillHistory(backfill, system(), 5);
      expect(resumed.ok && resumed.value.finished).toBe(true);
      expect((await progressOf())[0]).toMatchObject({
        kind: 'seller-orders',
        pages: 3,
        done: true,
      });
    });
  });
});

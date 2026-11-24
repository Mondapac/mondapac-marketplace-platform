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
  deliveryOf,
  refundSource,
  sellerOrderSource,
} from '../../src/modules/reporting/infrastructure/facade-report-sources';
import type { DeliveryRegions } from '../../src/modules/shipping';
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
import {
  reportingWorkerOwnerTestDatabaseUrl,
  reportingWorkerTestDatabaseUrl,
} from './test-database';

// Reporting's nightly reconcile on PostgreSQL (dashboards upgrade phase 3, PR 10b), for both
// Market fixtures, with the owners faked at the facade's shape: every page of changes is read and
// recorded in serializable units, a never-paid seller order is not recorded, an Offer catalog
// cannot place counts in the unknown category, a second run converges, a refund refused by the
// recorder fails its page only, and another Market's rows stay apart. The history backfill (PR 12)
// goes on from its saved cursor run after run with one window end for both kinds, counts a refused
// fact and goes on, writes a page again after a failed read or a failure that may pass, and lets
// only one of two overlapping runs move the cursor; the other Market's progress never moves.

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
  /** What shipping answers: region codes by quote id and by pickup seller. */
  regions: { quotes: Map<string, string>; pickups: Map<Id<'Seller'>, string> } = {
    quotes: new Map(),
    pickups: new Map(),
  };
  reads = 0;

  sellerOrders(_context: CallContext, refs: readonly SellerOrderSourceRef[]) {
    this.reads += 1;
    const wanted = new Set(refs.map((ref) => ref.sellerOrderId));
    return Promise.resolve(
      ok(
        this.orders
          .filter((order) => wanted.has(order.sellerOrderId))
          .map((order) =>
            sellerOrderSource(
              order,
              this.categories,
              deliveryOf(order, this.regions as DeliveryRegions),
            ),
          ),
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
    db = createPersistence({ databaseUrl: reportingWorkerTestDatabaseUrl() });
    owner = new Client({ connectionString: reportingWorkerOwnerTestDatabaseUrl() });
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
    deliveryQuoteId: null,
    deliveryMethod: 'instant',
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
    const limits = (maxPages: number) => ({ maxPages, budgetMs: 60_000 });
    const progressOf = async (target: MarketContext = market) =>
      (
        await owner.query<{
          kind: string;
          after: string | null;
          pages: number;
          failed: number;
          done: boolean;
        }>(
          `SELECT kind, after::text AS after, pages, failed_facts AS failed,
                  finished_at IS NOT NULL AS done
             FROM reporting.backfill_progress WHERE market_id = $1 ORDER BY kind DESC`,
          [target.marketId],
        )
      ).rows;
    const idsOf = <T>(items: readonly T[], key: (item: T) => string) => items.map(key).sort();
    const refundOf = (order: SellerOrderReportFacts, refundCurrency = currency) => ({
      refundId: idOf<'Refund'>(),
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId: order.sellerId,
      currency: refundCurrency,
      total: { amount: 1100n, tax: 100n },
      shipping: { amount: 0n, tax: 0n },
      refundedAt: T0.subtract({ hours: 240 }),
      lines: [
        { offerId: order.lines[0]!.offerId, quantity: 1, goods: { amount: 1100n, tax: 100n } },
      ],
    });
    const stored = async (sellerId: string) =>
      (
        await owner.query<{ orders: string; refunds: string }>(
          `SELECT (SELECT count(*) FROM reporting.seller_orders WHERE seller_id = $1) AS orders,
                  (SELECT count(*) FROM reporting.refunds WHERE seller_id = $1) AS refunds`,
          [sellerId],
        )
      ).rows[0];

    beforeEach(async () => {
      await owner.query('DELETE FROM reporting.backfill_progress WHERE market_id = ANY($1)', [
        [market.marketId, other.marketId],
      ]);
      // The other Market is part way through its own backfill: no run of this Market moves it.
      await owner.query(
        `INSERT INTO reporting.backfill_progress (market_id, tenant_id, kind, until, after, pages,
           failed_facts, started_at, updated_at)
         VALUES ($1, $2, 'seller-orders', $3, $4, 7, 0, $3, $3)`,
        [other.marketId, other.tenantId, new Date(T0.epochMilliseconds), idOf<'SellerOrder'>()],
      );
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
          succeededRefunds: (context, window, after, limit) => {
            windows.push(window);
            return sources.succeededRefunds(context, window, after, limit);
          },
        },
        progress: new PrismaBackfillProgressStore(db.service, () => Temporal.Now.instant()),
        facts: new PrismaFactStore(db.service, () => Temporal.Now.instant()),
      };
    });

    it('goes on from the saved cursor run after run, up to the instant it started', async () => {
      const elsewhere = await progressOf(other);
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 250; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 24 * (400 - i) })));
      for (const order of owners.orders.slice(0, 120)) owners.refundFacts.push(refundOf(order));
      const orderIds = idsOf(owners.orders, (order) => order.sellerOrderId);

      const first = await backfillHistory(backfill, system(), limits(2));
      expect(first).toEqual(
        ok({ sellerOrders: 200, refunds: 0, failedFacts: 0, pages: 2, finished: false }),
      );
      // Both kinds start together, with one window end.
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: orderIds[199], pages: 2, failed: 0, done: false },
        { kind: 'refunds', after: null, pages: 0, failed: 0, done: false },
        { kind: 'delivery', after: null, pages: 0, failed: 0, done: false },
      ]);

      // A later run keeps the window end fixed at the first start, for both kinds.
      backfill = { ...backfill, clock: new FixedClock(T0.add({ hours: 3 })) };
      const second = await backfillHistory(backfill, system(), limits(2));
      expect(second).toEqual(
        ok({ sellerOrders: 50, refunds: 100, failedFacts: 0, pages: 2, finished: false }),
      );
      const third = await backfillHistory(backfill, system(), limits(2));
      expect(third).toEqual(
        // The last refund page, then the delivery pass: every row here already has its method.
        ok({ sellerOrders: 0, refunds: 20, failedFacts: 0, pages: 2, finished: true }),
      );
      expect(windows.length).toBe(5);
      expect(windows.every((window) => window.from === null && window.to.equals(T0))).toBe(true);
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: orderIds[199], pages: 3, failed: 0, done: true },
        {
          kind: 'refunds',
          after: idsOf(owners.refundFacts, (refund) => refund.refundId)[99],
          pages: 2,
          failed: 0,
          done: true,
        },
        { kind: 'delivery', after: null, pages: 1, failed: 0, done: true },
      ]);
      expect(await stored(sellerId)).toEqual({ orders: '250', refunds: '120' });

      // Finished: a run reads nothing more, and the other Market's progress never moved.
      const reads = owners.reads;
      const idle = await backfillHistory(backfill, system(), limits(2));
      expect(idle).toEqual(
        ok({ sellerOrders: 0, refunds: 0, failedFacts: 0, pages: 0, finished: true }),
      );
      expect(owners.reads).toBe(reads);
      expect(windows.length).toBe(5);
      expect(await progressOf(other)).toEqual(elsewhere);
    });

    it('counts a refused fact and goes on, but writes a page again after a failure that may pass', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 3; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 720 })));
      // Another currency than the Market's: the recorder refuses it, whenever it is written.
      owners.refundFacts.push(refundOf(owners.orders[0]!, currency === 'AUD' ? 'JPY' : 'AUD'));
      owners.refundFacts.push(refundOf(owners.orders[1]!));

      // A seller order whose every write fails as a lost connection would.
      const flaky = owners.orders[2]!.sellerOrderId;
      const recorder = deps.recorder;
      const failing: BackfillDependencies = {
        ...backfill,
        recorder: Object.assign(Object.create(recorder) as FactRecorder, {
          recordBatch: (
            target: MarketContext,
            facts: Parameters<FactRecorder['recordBatch']>[1],
          ) =>
            facts.sellerOrders.some((source) => source.order.sellerOrderId === flaky)
              ? Promise.reject(new Error('connection lost'))
              : recorder.recordBatch(target, facts),
        }),
      };
      const stopped = await backfillHistory(failing, system(), limits(5));
      expect(!stopped.ok && stopped.error.cause).toBe('reporting seller-orders write');
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: null, pages: 0, failed: 0, done: false },
        { kind: 'refunds', after: null, pages: 0, failed: 0, done: false },
        { kind: 'delivery', after: null, pages: 0, failed: 0, done: false },
      ]);

      // The connection is back: the page is written again, and the refused refund is counted.
      const done = await backfillHistory(backfill, system(), limits(5));
      expect(done).toEqual(
        ok({ sellerOrders: 3, refunds: 1, failedFacts: 1, pages: 3, finished: true }),
      );
      expect(await progressOf()).toEqual([
        { kind: 'seller-orders', after: null, pages: 1, failed: 0, done: true },
        { kind: 'refunds', after: null, pages: 1, failed: 1, done: true },
        { kind: 'delivery', after: null, pages: 1, failed: 0, done: true },
      ]);
      expect(await stored(sellerId)).toEqual({ orders: '3', refunds: '1' });
    });

    it('keeps the cursor where it was when a read fails', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 150; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 720 })));
      const down: ReportSources['sellerOrders'] = () =>
        Promise.resolve(err({ code: 'reporting.source-unavailable', cause: 'down' }));
      const failing = { ...backfill, sources: { ...backfill.sources, sellerOrders: down } };
      const stopped = await backfillHistory(failing, system(), limits(5));
      expect(!stopped.ok && stopped.error.code).toBe('reporting.source-unavailable');
      expect((await progressOf())[0]).toEqual({
        kind: 'seller-orders',
        after: null,
        pages: 0,
        failed: 0,
        done: false,
      });
      const resumed = await backfillHistory(backfill, system(), limits(5));
      expect(resumed.ok && resumed.value.finished).toBe(true);
      expect(await stored(sellerId)).toEqual({ orders: '150', refunds: '0' });
    });

    it('lets exactly one of two concurrent steps from one place move the cursor', async () => {
      const started = await db.unitOfWork.run(market, async () =>
        ok(await backfill.progress.startAll(market, T0)),
      );
      if (!started.ok) throw new Error('start');
      const from = started.value[0]!;
      const step = { after: idOf<'SellerOrder'>(), pages: 1, failedFacts: 0, finished: false };
      const steps = await Promise.all(
        [0, 1].map(() =>
          db.unitOfWork.run(market, async () =>
            ok(await backfill.progress.advance(market, from, step)),
          ),
        ),
      );
      expect(steps.filter((moved) => moved.ok && moved.value !== null)).toHaveLength(1);
      expect((await progressOf())[0]).toMatchObject({ after: step.after, pages: 1 });
    });

    it('ends with every page counted once when two runs overlap', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      for (let i = 0; i < 250; i += 1)
        owners.orders.push(sellerOrder(sellerId, offer, T0.subtract({ hours: 720 })));
      const runs = await Promise.all([
        backfillHistory(backfill, system(), limits(20)),
        backfillHistory(backfill, system(), limits(20)),
      ]);
      expect(runs.every((run) => run.ok)).toBe(true);
      // A run overtaken stops; one more run finishes whatever is left.
      await backfillHistory(backfill, system(), limits(20));
      expect(await progressOf()).toEqual([
        {
          kind: 'seller-orders',
          after: idsOf(owners.orders, (order) => order.sellerOrderId)[199],
          pages: 3,
          failed: 0,
          done: true,
        },
        { kind: 'refunds', after: null, pages: 1, failed: 0, done: true },
        { kind: 'delivery', after: null, pages: 1, failed: 0, done: true },
      ]);
      expect(await stored(sellerId)).toEqual({ orders: '250', refunds: '0' });
    });

    it('fills the delivery of rows recorded before the columns, resuming from its cursor', async () => {
      const sellerId = idOf<'Seller'>();
      const offer = idOf<'Offer'>();
      const [north, south] = code === 'AU' ? ['QLD', 'VIC'] : ['ZA', 'ZB'];
      // 150 seller orders: deliveries with a quote, one without (placed before quotes were kept),
      // and pickups whose state is the store's.
      for (let i = 0; i < 150; i += 1) {
        const base = sellerOrder(sellerId, offer, T0.subtract({ hours: 720 }));
        const quoteId = idOf<'DeliveryQuote'>();
        const order: SellerOrderReportFacts =
          i % 3 === 0
            ? { ...base, deliveryMethod: 'pickup', deliveryQuoteId: null }
            : i === 1
              ? { ...base, deliveryMethod: 'scheduled', deliveryQuoteId: null }
              : { ...base, deliveryMethod: 'same_day', deliveryQuoteId: quoteId };
        owners.orders.push(order);
        owners.regions.quotes.set(quoteId, north);
      }
      owners.regions.pickups.set(sellerId, south);
      // The history backfill had finished before the delivery pass existed.
      await reconcileWindow(deps, system(), window);
      await owner.query(
        `INSERT INTO reporting.backfill_progress (market_id, tenant_id, kind, until, after, pages,
           failed_facts, started_at, updated_at, finished_at)
         SELECT $1, $2, kind, $3, NULL, 1, 0, $3, $3, $3
           FROM unnest(ARRAY['seller-orders', 'refunds']) AS kind`,
        [market.marketId, market.tenantId, new Date(T0.epochMilliseconds)],
      );
      // Rows as an earlier release recorded them: no method, no state.
      await owner.query(
        `UPDATE reporting.seller_orders SET delivery_method = NULL, delivery_state = NULL
          WHERE seller_id = $1`,
        [sellerId],
      );
      const ids = idsOf(owners.orders, (order) => order.sellerOrderId);

      const first = await backfillHistory(backfill, system(), limits(1));
      expect(first).toEqual(
        ok({ sellerOrders: 100, refunds: 0, failedFacts: 0, pages: 1, finished: false }),
      );
      expect((await progressOf()).find((row) => row.kind === 'delivery')).toEqual({
        kind: 'delivery',
        after: ids[99],
        pages: 1,
        failed: 0,
        done: false,
      });
      const second = await backfillHistory(backfill, system(), limits(5));
      expect(second).toEqual(
        ok({ sellerOrders: 50, refunds: 0, failedFacts: 0, pages: 1, finished: true }),
      );

      const rows = (
        await owner.query<{ id: string; method: string | null; state: string | null }>(
          `SELECT seller_order_id::text AS id, delivery_method AS method, delivery_state AS state
             FROM reporting.seller_orders WHERE seller_id = $1`,
          [sellerId],
        )
      ).rows;
      const expected = new Map(
        owners.orders.map((order) => [
          order.sellerOrderId as string,
          {
            method: order.deliveryMethod,
            state:
              order.deliveryMethod === 'pickup'
                ? south
                : order.deliveryQuoteId === null
                  ? null
                  : north,
          },
        ]),
      );
      expect(rows).toHaveLength(150);
      for (const row of rows) {
        expect({ method: row.method, state: row.state }).toEqual(expected.get(row.id));
      }
      // The unknown state stays null, and the pass does not visit the row again.
      expect(rows.filter((row) => row.state === null)).toHaveLength(1);
      const reads = owners.reads;
      await backfillHistory(backfill, system(), limits(5));
      expect(owners.reads).toBe(reads);
      // Nothing about the delivery is in the rollups: one day, 150 orders, as before.
      expect((await days(sellerId)).map((row) => row.orders_paid)).toEqual([150]);
    });
  });
});

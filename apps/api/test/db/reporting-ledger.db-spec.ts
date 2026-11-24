import { err, money, ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ledgerEntriesRecorded,
  ledgerReportEntries,
} from '../../src/modules/commission-payouts/application/ledger-report-flow';
import type { CommissionPayoutsReportingFacade } from '../../src/modules/commission-payouts/contracts/commission-payouts-reporting.facade';
import type { LedgerEntry, LedgerKind } from '../../src/modules/commission-payouts/domain/ledger';
import { PrismaLedgerReportReader } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger-report.reader';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import {
  backfillLedger,
  recordLedgerFromEvent,
  type LedgerBackfillDependencies,
} from '../../src/modules/reporting/application/ledger-facts-sync';
import { readNetFigures } from '../../src/modules/reporting/application/ledger-kpi-flow';
import { LedgerRecorder } from '../../src/modules/reporting/application/ledger-recorder';
import { ReportingLedgerConflict } from '../../src/modules/reporting/application/ports/ledger-fact-store';
import type {
  LedgerSourceEntry,
  LedgerSources,
} from '../../src/modules/reporting/application/ports/ledger-sources';
import { netRevenueOf, sellerNetEarningsOf } from '../../src/modules/reporting/domain/ledger';
import { FacadeLedgerSources } from '../../src/modules/reporting/infrastructure/facade-ledger-sources';
import { PrismaBackfillProgressStore } from '../../src/modules/reporting/infrastructure/prisma-backfill-progress-store';
import { PrismaLedgerFactStore } from '../../src/modules/reporting/infrastructure/prisma-ledger-fact-store';
import { PrismaLedgerKpiReader } from '../../src/modules/reporting/infrastructure/prisma-ledger-kpi-reader';
import { issueDelivery } from '../../src/platform/persistence/outbox/delivery-ledger';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import {
  reportingLedgerOwnerTestDatabaseUrl,
  reportingLedgerTestDatabaseUrl,
} from './test-database';

// Reporting's ledger facts on PostgreSQL (dashboards v2, phase 1, PR 4), for both Market fixtures,
// end to end from commission-payouts' real ledger table through its reporting facade: the
// `ledger-recorded` worker records a seller order's commission, refund-commission and seller
// cashback rows once per delivery (a redelivery changes nothing), the daily rollup, net revenue
// (a refund's commission with the opposite sign) and a seller's net earnings (its cashback taken
// off), a changed ledger row is a conflict, the ledger backfill goes on from its saved cursor and
// stops before the cursor after a failed read, two units writing one seller day keep the rollup
// equal to the facts, and the "matching ledger" readiness (a clean backfill, enough activity, a
// payment at the Market's midnight on the same day on both sides). Every day of
// this file is in 2031, so the sales facts of other spec files sharing the database never fall in
// its readiness window.

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
/** "Now" of the file: noon in Brisbane, 11:00 in Tokyo, on 10 March 2031. */
const NOW = Temporal.Instant.from('2031-03-10T02:00:00Z');
/** A payment on 20 February 2031 in both zones, outside the readiness window (3 to 9 March). */
const PAID = Temporal.Instant.from('2031-02-20T03:00:00Z');
const REFUNDED = Temporal.Instant.from('2031-02-21T03:00:00Z');
/** A payment on 5 March 2031, inside the readiness window. */
const PAID_IN_WINDOW = Temporal.Instant.from('2031-03-05T03:00:00Z');

describe.each(TEST_MARKETS)('reporting ledger facts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  const zone = {
    zoneOf: (target: MarketContext) => ZONES[target.marketId] as string,
    currencyOf: (target: MarketContext) => CURRENCIES[target.marketId] as string,
  };
  const clock = new FixedClock(NOW);
  const system = (target: MarketContext = market): CallContext => testCallContext(target, 'system');
  let db: Persistence;
  let owner: Client;
  let ledger: PrismaLedgerRepository;
  let facade: CommissionPayoutsReportingFacade;
  let deps: LedgerBackfillDependencies;
  let kpis: PrismaLedgerKpiReader;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: reportingLedgerTestDatabaseUrl() });
    owner = new Client({ connectionString: reportingLedgerOwnerTestDatabaseUrl() });
    await owner.connect();
    ledger = new PrismaLedgerRepository(db.service);
    const reader = new PrismaLedgerReportReader(db.service);
    const flow = { unitOfWork: db.unitOfWork, reader };
    // The facade's methods without the gate (rule `system`): the flows behind its use cases.
    facade = {
      ledgerReportEntries: (context, request) => ledgerReportEntries(flow, context, request),
      ledgerEntriesRecorded: (context, request) => ledgerEntriesRecorded(flow, context, request),
    };
    const now = () => Temporal.Now.instant();
    deps = {
      unitOfWork: db.unitOfWork,
      sources: new FacadeLedgerSources(facade),
      recorder: new LedgerRecorder({ store: new PrismaLedgerFactStore(db.service, now), zone }),
      clock,
      progress: new PrismaBackfillProgressStore(db.service, now),
    };
    kpis = new PrismaLedgerKpiReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  /** A seller order paid in the ledger: one line's sale and commission (15 % of the base). */
  const paidSellerOrder = (sellerId: Id<'Seller'>, base = 10_000n, paidAt = PAID) => {
    const ids = {
      sellerId,
      orderId: idOf<'Order'>(),
      sellerOrderId: idOf<'SellerOrder'>(),
      lineId: idOf<'OrderLine'>(),
    };
    const row = (kind: LedgerKind, amount: bigint, extra: Partial<LedgerEntry> = {}) => ({
      id: idOf<'LedgerEntry'>(),
      sellerId: ids.sellerId,
      orderId: ids.orderId,
      sellerOrderId: ids.sellerOrderId,
      orderLineId: ids.lineId,
      kind,
      amount: money(amount, currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
      occurredAt: paidAt,
      recordedAt: NOW,
      ...extra,
    });
    return {
      ids,
      paid: [
        row('sale', (base * 11n) / 10n),
        row('commission', (base * 15n) / 100n, { rateBps: 1500, baseAmount: base }),
      ],
      refund: (refundBase: bigint) =>
        row('refund-commission', (refundBase * 15n) / 100n, {
          rateBps: 1500,
          baseAmount: refundBase,
          sourceId: idOf<'Refund'>(),
          occurredAt: REFUNDED,
        }),
      cashback: (amount: bigint) =>
        row('cashback-seller', amount, {
          orderLineId: null,
          sourceId: idOf<'PromotionCredit'>(),
          occurredAt: REFUNDED,
        }),
    };
  };
  const append = (target: MarketContext, rows: readonly LedgerEntry[]) =>
    db.unitOfWork.run(target, async () => ok(await ledger.append(target, rows)));
  const deliver = (sellerOrderId: string, target: MarketContext = market, eventId = idOf()) =>
    recordLedgerFromEvent(
      deps,
      system(target),
      issueDelivery(
        { eventId: eventId as Id<'event'>, subscriber: 'reporting.ledger-recorded', attempt: 1 },
        target,
        () => NOW,
      ),
      sellerOrderId,
    );
  const facts = async (sellerOrderId: string) =>
    (
      await owner.query<{ market_id: string; kind: string; amount: string; market_day: Date }>(
        `SELECT market_id, kind, amount, market_day FROM reporting.ledger_entries
          WHERE seller_order_id = $1 ORDER BY kind`,
        [sellerOrderId],
      )
    ).rows;
  const rollup = async (sellerId: string) =>
    (
      await owner.query<{ kind: string; entries: number; seller_orders: number; amount: string }>(
        `SELECT kind, entries, seller_orders, amount FROM reporting.daily_ledger
          WHERE seller_id = $1 ORDER BY market_day, kind`,
        [sellerId],
      )
    ).rows;
  const kpiDeps = () => ({ unitOfWork: db.unitOfWork, reader: kpis, zone, clock });
  const february = { from: '2031-02-01', to: '2031-02-28' } as never;
  const range = { from: '2031-03-01', to: '2031-03-10' };

  it('records a posting once per delivery, the refund commission and the cashback with their signs', async () => {
    const sellerId = idOf<'Seller'>();
    const order = paidSellerOrder(sellerId);
    await append(market, order.paid);
    const first = idOf();
    expect(await deliver(order.ids.sellerOrderId, market, first)).toEqual(
      ok({ handled: true, entries: 1 }),
    );
    // The sale row is not reporting's: only the commission is recorded.
    expect((await facts(order.ids.sellerOrderId)).map((row) => row.kind)).toEqual(['commission']);

    // The same delivery again: the inbox has it, nothing is written.
    expect(await deliver(order.ids.sellerOrderId, market, first)).toEqual(
      ok({ handled: false, entries: 0 }),
    );

    // A refund (base 2,000) and a cashback; their events read the whole seller order again.
    await append(market, [order.refund(2_000n), order.cashback(500n)]);
    expect(await deliver(order.ids.sellerOrderId)).toEqual(ok({ handled: true, entries: 3 }));
    // A late, repeated event of an earlier posting converges on the same rows.
    expect(await deliver(order.ids.sellerOrderId)).toEqual(ok({ handled: true, entries: 3 }));
    expect((await facts(order.ids.sellerOrderId)).map((row) => [row.kind, row.amount])).toEqual([
      ['cashback-seller', '500'],
      ['commission', '1500'],
      ['refund-commission', '300'],
    ]);
    // The refund and the cashback fall on their own day.
    expect(await rollup(sellerId)).toEqual([
      { kind: 'commission', entries: 1, seller_orders: 1, amount: '1500' },
      { kind: 'cashback-seller', entries: 1, seller_orders: 1, amount: '500' },
      { kind: 'refund-commission', entries: 1, seller_orders: 1, amount: '300' },
    ]);

    const seller = await db.unitOfWork.run(
      market,
      async () => ok(await kpis.rangeSums(market, currency, february, sellerId)),
      { readOnly: true },
    );
    if (!seller.ok) throw new Error('read failed');
    // The refund gives commission back: net revenue 1500 - 300.
    expect(netRevenueOf(seller.value.sums, currency).components.commission).toEqual({
      status: 'available',
      amount: 1200n,
    });
    // 10000 - 2000 - 1200 - 500.
    expect(sellerNetEarningsOf(seller.value.sums, currency).netEarnings).toBe(6300n);
  });

  it('keeps Markets apart', async () => {
    const sellerId = idOf<'Seller'>();
    const order = paidSellerOrder(sellerId);
    await append(market, order.paid);
    // Asked in the other Market, the seller order has no ledger rows there.
    expect(await deliver(order.ids.sellerOrderId, other)).toEqual(
      ok({ handled: true, entries: 0 }),
    );
    expect(await facts(order.ids.sellerOrderId)).toEqual([]);
    await deliver(order.ids.sellerOrderId);
    expect((await facts(order.ids.sellerOrderId)).map((row) => row.market_id)).toEqual([code]);
  });

  it('refuses a ledger row that differs from the stored one', async () => {
    const sellerId = idOf<'Seller'>();
    const order = paidSellerOrder(sellerId);
    await append(market, order.paid);
    await deliver(order.ids.sellerOrderId);
    const read = await deps.sources.entriesOf(system(), [order.ids.sellerOrderId]);
    if (!read.ok) throw new Error('read failed');
    const changed = read.value.map((entry) => ({ ...entry, amount: entry.amount + 1n }));
    await expect(
      db.unitOfWork.run(market, async () => ok(await deps.recorder.record(market, changed)), {
        isolation: 'serializable',
      }),
    ).rejects.toBeInstanceOf(ReportingLedgerConflict);
    // A row in another currency than the Market's is refused before anything is written.
    const foreign = read.value.map((entry) => ({ ...entry, currency: 'XXX' }));
    await expect(
      db.unitOfWork.run(market, async () => ok(await deps.recorder.record(market, foreign))),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('pages recorded rows by entry id, the reportable kinds only', async () => {
    const sellerId = idOf<'Seller'>();
    const recordedAt = Temporal.Instant.from(`2031-01-0${code === 'AU' ? 1 : 2}T00:00:00Z`);
    const orders = [
      paidSellerOrder(sellerId),
      paidSellerOrder(sellerId),
      paidSellerOrder(sellerId),
    ];
    await append(
      market,
      orders.flatMap((order) => order.paid.map((row) => ({ ...row, recordedAt }))),
    );
    const window = { from: recordedAt, to: recordedAt.add({ hours: 1 }) };
    const first = await facade.ledgerEntriesRecorded(system(), { window, after: null, limit: 2 });
    if (!first.ok) throw new Error('read failed');
    expect(first.value.entries.map((entry) => entry.kind)).toEqual(['commission', 'commission']);
    expect(first.value.next).not.toBeNull();
    const second = await facade.ledgerEntriesRecorded(system(), {
      window,
      after: first.value.next,
      limit: 2,
    });
    if (!second.ok) throw new Error('read failed');
    expect(second.value.entries).toHaveLength(1);
    expect(second.value.next).toBeNull();
    // Ids and money only.
    expect(Object.keys(second.value.entries[0]!).sort()).toEqual([
      'amount',
      'baseAmount',
      'currency',
      'entryId',
      'kind',
      'occurredAt',
      'sellerId',
      'sellerOrderId',
    ]);
    expect(
      await facade.ledgerEntriesRecorded(system(), { window, after: 'nope', limit: 2 }),
    ).toEqual(err({ code: 'validation.failed' }));
    expect(await facade.ledgerReportEntries(system(), { sellerOrderIds: [] })).toEqual(
      err({ code: 'validation.failed' }),
    );
  });

  it('keeps the rollup equal to the sum of the facts when two units write the same seller day', async () => {
    const sellerId = idOf<'Seller'>();
    const orders = [paidSellerOrder(sellerId, 10_000n), paidSellerOrder(sellerId, 20_000n)];
    await append(
      market,
      orders.flatMap((order) => order.paid),
    );
    const results = await Promise.all(orders.map((order) => deliver(order.ids.sellerOrderId)));
    expect(results).toEqual([ok({ handled: true, entries: 1 }), ok({ handled: true, entries: 1 })]);
    const sum = (
      await owner.query<{ amount: string; orders: string }>(
        `SELECT SUM(amount)::text AS amount, COUNT(DISTINCT seller_order_id)::text AS orders
           FROM reporting.ledger_entries WHERE seller_id = $1 AND kind = 'commission'`,
        [sellerId],
      )
    ).rows[0]!;
    expect(sum).toEqual({ amount: '4500', orders: '2' });
    expect(await rollup(sellerId)).toEqual([
      { kind: 'commission', entries: 2, seller_orders: 2, amount: sum.amount },
    ]);
  });

  describe('backfill and readiness', () => {
    const resetProgress = () =>
      owner.query(
        `DELETE FROM reporting.backfill_progress WHERE market_id = $1 AND kind = 'ledger'`,
        [code],
      );
    const progressOf = async () =>
      (
        await owner.query<{ after: string | null; pages: number; finished_at: Date | null }>(
          `SELECT after, pages, finished_at FROM reporting.backfill_progress
            WHERE market_id = $1 AND kind = 'ledger'`,
          [code],
        )
      ).rows[0];

    /** The ledger as a list, paged by entry id: the backfill's only source here. */
    const fakeLedger = (rows: LedgerSourceEntry[], failAt: number | null = null) => {
      let reads = 0;
      const sources: LedgerSources = {
        entriesOf: () => Promise.resolve(ok([])),
        entriesRecorded: (_context, _window, after, limit) => {
          reads += 1;
          if (failAt !== null && reads === failAt) {
            return Promise.resolve(
              err({ code: 'reporting.source-unavailable', cause: 'test' } as const),
            );
          }
          const rest = rows
            .filter((row) => after === null || row.entryId > after)
            .sort((a, b) => (a.entryId < b.entryId ? -1 : 1));
          const items = rest.slice(0, limit);
          return Promise.resolve(
            ok({ items, next: rest.length > limit ? items[items.length - 1]!.entryId : null }),
          );
        },
      };
      return sources;
    };
    const sourceRows = (sellerId: Id<'Seller'>, count: number): LedgerSourceEntry[] =>
      Array.from({ length: count }, () => ({
        entryId: idOf<'LedgerEntry'>(),
        sellerOrderId: idOf<'SellerOrder'>(),
        sellerId,
        kind: 'commission' as const,
        amount: 150n,
        baseAmount: 1000n,
        currency,
        occurredAt: PAID,
      }));

    it('goes on from its saved cursor run after run, and stops before it after a failed read', async () => {
      await resetProgress();
      const sellerId = idOf<'Seller'>();
      // 450 rows: three pages of 200.
      const rows = sourceRows(sellerId, 450);
      const limits = { maxPages: 1, budgetMs: 60_000 };
      const failing = { ...deps, sources: fakeLedger(rows, 2) };
      const run1 = await backfillLedger(failing, system(), limits);
      expect(run1).toEqual(ok({ entries: 200, failedFacts: 0, pages: 1, finished: false }));
      const saved = (await progressOf())!.after;
      // The second read fails: nothing moves.
      expect((await backfillLedger(failing, system(), limits)).ok).toBe(false);
      expect((await progressOf())!.after).toBe(saved);
      const good = { ...deps, sources: fakeLedger(rows) };
      expect(await backfillLedger(good, system(), limits)).toEqual(
        ok({ entries: 200, failedFacts: 0, pages: 1, finished: false }),
      );
      expect(await backfillLedger(good, system(), limits)).toEqual(
        ok({ entries: 50, failedFacts: 0, pages: 1, finished: true }),
      );
      expect((await progressOf())!.finished_at).not.toBeNull();
      // Finished: a tick reads only the progress row.
      expect(await backfillLedger(good, system(), limits)).toEqual(
        ok({ entries: 0, failedFacts: 0, pages: 0, finished: true }),
      );
      expect(await rollup(sellerId)).toEqual([
        { kind: 'commission', entries: 450, seller_orders: 450, amount: String(450 * 150) },
      ]);
    });

    it('counts a refused row, passes over it and finishes', async () => {
      await resetProgress();
      const sellerId = idOf<'Seller'>();
      const rows = sourceRows(sellerId, 3);
      rows[1] = { ...rows[1]!, currency: 'XXX' };
      const result = await backfillLedger({ ...deps, sources: fakeLedger(rows) }, system());
      expect(result).toEqual(ok({ entries: 2, failedFacts: 1, pages: 1, finished: true }));
    });

    it('is ready only after a clean backfill, with enough activity, while every paid seller order of the week has its commission', async () => {
      await resetProgress();
      const read = () => readNetFigures(kpiDeps(), system(), { range }, null);
      expect(await read()).toMatchObject({
        ok: true,
        value: { readiness: { ready: false, reason: 'backfill-not-finished' } },
      });
      await backfillLedger({ ...deps, sources: fakeLedger([]) }, system());

      const sellerId = idOf<'Seller'>();
      // A method, as every fact recorded since the delivery columns has: a row without one is the
      // backfill's `delivery` pass's to fill, and would join another spec's pass of the Market.
      const salesFact = (sellerOrderId: string, goods: bigint, paidAt = PAID_IN_WINDOW) =>
        owner.query(
          `INSERT INTO reporting.seller_orders (market_id, tenant_id, seller_order_id, order_id,
             seller_id, currency, goods_amount, goods_tax_amount, units, shipping_amount,
             shipping_tax_amount, paid_at, paid_day, recorded_at, updated_at, delivery_method)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 1, 0, 0, $8, $9, $10, $10, 'instant')`,
          [
            code,
            market.tenantId,
            sellerOrderId,
            idOf(),
            sellerId,
            currency,
            String(goods),
            new Date(paidAt.epochMilliseconds),
            // The paid day as the sales facts work it out: the payment's day in the Market's zone.
            paidAt
              .toZonedDateTimeISO(ZONES[code] as string)
              .toPlainDate()
              .toString(),
            new Date(NOW.epochMilliseconds),
          ],
        );
      /** A paid seller order with its commission fact and its sales fact. */
      const matched = async (paidAt: Temporal.Instant) => {
        const order = paidSellerOrder(sellerId, 10_000n, paidAt);
        await append(market, order.paid);
        await deliver(order.ids.sellerOrderId);
        await salesFact(order.ids.sellerOrderId, 11_000n, paidAt);
        return order;
      };
      /** An instant at a wall-clock time of a window day in the Market's zone. */
      const local = (day: string, time: string) =>
        Temporal.PlainDateTime.from(`${day}T${time}`)
          .toZonedDateTime(ZONES[code] as string)
          .toInstant();

      // One matched seller order matches every day, but a week this quiet proves nothing.
      await matched(PAID_IN_WINDOW);
      // A fully discounted seller order (goods 0) writes no commission row and is left out.
      await salesFact(idOf(), 0n);
      const quiet = await read();
      if (!quiet.ok) throw new Error('read failed');
      expect(quiet.value.readiness).toMatchObject({
        ready: false,
        reason: 'insufficient-activity',
        matchedSellerOrders: 1,
      });

      // Paid seconds before and after the Market's midnight: the ledger day and the paid day are
      // both the payment's day in the Market's zone, so they agree.
      const beforeMidnight = await matched(local('2031-03-06', '23:59:30'));
      const afterMidnight = await matched(local('2031-03-07', '00:00:30'));
      expect((await facts(beforeMidnight.ids.sellerOrderId))[0]!.market_day.toISOString()).toMatch(
        /^2031-03-06/,
      );
      expect((await facts(afterMidnight.ids.sellerOrderId))[0]!.market_day.toISOString()).toMatch(
        /^2031-03-07/,
      );
      for (const day of ['2031-03-03', '2031-03-04', '2031-03-08', '2031-03-09'])
        await matched(local(day, '12:00:00'));
      const ready = await read();
      if (!ready.ok) throw new Error('read failed');
      expect(ready.value.readiness).toMatchObject({
        ready: true,
        reason: 'ready',
        matchedSellerOrders: 7,
        window: { from: '2031-03-03', to: '2031-03-09' },
      });
      expect(ready.value.readiness.days[2]).toMatchObject({
        day: '2031-03-05',
        paidSellerOrders: 1,
        ledgerSellerOrders: 1,
        matches: true,
      });
      expect(ready.value.readiness.days[3]).toMatchObject({ day: '2031-03-06', matches: true });
      expect(ready.value.readiness.days[4]).toMatchObject({ day: '2031-03-07', matches: true });

      // A backfill that refused a row left a hole: not ready, however well the week matches.
      await owner.query(
        `UPDATE reporting.backfill_progress SET failed_facts = 1
          WHERE market_id = $1 AND kind = 'ledger'`,
        [code],
      );
      expect(await read()).toMatchObject({
        ok: true,
        value: { readiness: { ready: false, reason: 'backfill-refused-rows' } },
      });
      await owner.query(
        `UPDATE reporting.backfill_progress SET failed_facts = 0
          WHERE market_id = $1 AND kind = 'ledger'`,
        [code],
      );

      // A paid seller order whose ledger rows never arrived: the week no longer matches.
      await salesFact(idOf(), 5_000n);
      const missing = await read();
      if (!missing.ok) throw new Error('read failed');
      expect(missing.value.readiness).toMatchObject({ ready: false, reason: 'days-not-matching' });
      expect(missing.value.readiness.days[2]).toMatchObject({ missingInLedger: 1 });

      // A range over 13 months, or ending after today, is refused.
      expect(
        await readNetFigures(
          kpiDeps(),
          system(),
          { range: { from: '2030-01-01', to: '2031-03-01' } },
          null,
        ),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'from', code: 'too-long' }] }));
      expect(
        await readNetFigures(
          kpiDeps(),
          system(),
          { range: { from: '2031-03-01', to: '2031-03-11' } },
          null,
        ),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'to', code: 'future' }] }));
    });
  });
});

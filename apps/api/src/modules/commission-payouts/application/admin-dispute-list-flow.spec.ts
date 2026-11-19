import { Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeSellerNames,
  MarketLedger,
  MemoryDisputes,
} from '../../../../test/support/commission-payouts-dispute-fakes';
import { MemoryAdminDisputeList } from '../../../../test/support/commission-payouts-dispute-list-fakes';
import {
  FakeStoreSearch,
  ScriptedProbe,
} from '../../../../test/support/commission-payouts-list-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { DisputeCase } from '../domain/dispute';
import type { LedgerEntry } from '../domain/ledger';
import {
  DISPUTE_ROW_KEYS,
  DISPUTE_SELLER_ORDERS_MAX,
  exportAdminDisputes,
  listAdminDisputes,
  type AdminDisputeListDependencies,
  type AdminDisputeListPage,
} from './admin-dispute-list-flow';

// The admin Disputes super list (phase 4, list 23) and its export, on both Market fixtures: AU in
// AUD (two minor digits), ZZ in JPY (none). Nothing here moves money; Stripe's dispute id never
// leaves the case page.

const FIXTURES = { AU: { currency: 'AUD' }, ZZ: { currency: 'JPY' } } as const;
const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const ADMIN = id<'Account'>(0xad);

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}
const linesOf = async (file: ExportFile) => (await text(file)).split('\r\n').filter(Boolean);

describe.each([['AU'], ['ZZ']] as const)('the admin Disputes list in market %s', (code) => {
  const { currency } = FIXTURES[code];
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const actorOf = (m: MarketContext, population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? SELLER_A : null,
      }),
      `cp-${population}-disputes`,
    );
  const admin = actorOf(market, 'admin');

  let ledger: MarketLedger;
  let disputes: MemoryDisputes;
  let reader: MemoryAdminDisputeList;
  let names: FakeSellerNames;
  let search: FakeStoreSearch;
  let decide: ScriptedProbe;
  let deps: AdminDisputeListDependencies;
  let n: number;

  beforeEach(() => {
    ledger = new MarketLedger();
    disputes = new MemoryDisputes(ledger);
    reader = new MemoryAdminDisputeList(disputes, ledger);
    names = new FakeSellerNames();
    names.names.set(SELLER_A, 'Halal Corner');
    names.names.set(SELLER_B, 'Spice Lane');
    search = new FakeStoreSearch(names.names);
    decide = new ScriptedProbe(true);
    const [attributeKey] = DISPUTE_ROW_KEYS;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      list: reader,
      disputes,
      sellerNames: names,
      storeSearch: search,
      probes: { [attributeKey]: decide },
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(T0),
    };
    n = 0;
  });

  /** A seller order of `orderId` for `sellerId` in the ledger (what names a case's sellers). */
  const sell = async (orderId: Id<'Order'>, sellerId: Id<'Seller'>, m: MarketContext = market) => {
    n += 1;
    const entry: LedgerEntry = {
      id: id<'LedgerEntry'>(0x9000 + n),
      sellerId,
      orderId,
      sellerOrderId: id<'SellerOrder'>(0x8000 + n),
      orderLineId: id<'OrderLine'>(0x7000 + n),
      kind: 'sale',
      amount: money(1000n, currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
      occurredAt: T0,
      recordedAt: T0,
    };
    await ledger.append(m, [entry]);
  };

  /** A case of the Market, opened `minutes` after T0, with one seller order of `seller`. */
  const add = async (
    fields: Partial<DisputeCase> & {
      readonly minutes?: number;
      readonly seller?: Id<'Seller'> | null;
    } = {},
    m: MarketContext = market,
  ): Promise<DisputeCase> => {
    n += 1;
    const { minutes, seller, ...rest } = fields;
    const at = T0.add({ minutes: minutes ?? n });
    const c: DisputeCase = {
      disputeId: id<'Dispute'>(0x1000 + n),
      orderId: id<'Order'>(0x2000 + n),
      providerDisputeId: `dp_secret_${n}`,
      amount: money(2000n, currency),
      status: 'needs_response',
      inquiry: false,
      closed: false,
      outcome: null,
      reason: 'fraudulent',
      evidenceDueBy: null,
      fundsWithdrawn: false,
      fundsWithdrawnAt: null,
      fundsReinstated: false,
      fundsReinstatedAt: null,
      openedAt: at,
      closedAt: null,
      bucket: 'needs-response',
      lastSyncedVersion: 1,
      createdAt: at,
      updatedAt: at,
      ...rest,
    };
    disputes.cases.set(`${m.marketId}:${c.disputeId}`, c);
    if (seller !== null) await sell(c.orderId, seller ?? SELLER_A, m);
    return c;
  };

  const list = (input: Record<string, unknown>, context: CallContext = admin) =>
    listAdminDisputes(deps, context, input);
  const ids = (page: AdminDisputeListPage) => page.disputes.map((row) => row.disputeId);

  describe('reading', () => {
    it('answers page numbers by default: newest opened first, counts per view, sellers', async () => {
      const older = await add({ minutes: 1 });
      const lost = await add({
        minutes: 2,
        bucket: 'decision-needed',
        status: 'lost',
        closed: true,
        outcome: 'lost',
        fundsWithdrawn: true,
        seller: SELLER_B,
      });
      await sell(lost.orderId, SELLER_A);
      await add({}, otherMarket);
      const page = must(await list({}));
      expect(ids(page)).toEqual([lost.disputeId, older.disputeId]);
      expect(page).toMatchObject({
        total: 2,
        page: 1,
        pageSize: 25,
        nextCursor: null,
        searchCapped: false,
        counts: {
          all: 2,
          'needs-response': 1,
          'decision-needed': 1,
          'under-review': 0,
          won: 0,
          closed: 0,
        },
      });
      expect(page.disputes[0]).toMatchObject({
        orderId: lost.orderId,
        moneyState: 'withdrawn',
        amount: { amountMinor: 2000n, currency },
        sellers: [
          { sellerId: SELLER_B, storeName: 'Spice Lane' },
          { sellerId: SELLER_A, storeName: 'Halal Corner' },
        ],
        actions: ['open', 'decide'],
      });
      expect(page.disputes[1]!.actions).toEqual(['open']);
      expect(
        JSON.stringify(page, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)),
      ).not.toContain('dp_secret');
    });

    it('offers Decide only to a caller who may decide', async () => {
      await add({ bucket: 'decision-needed', status: 'lost', closed: true, outcome: 'lost' });
      decide.held = false;
      expect(must(await list({})).disputes[0]!.actions).toEqual(['open']);
    });

    it('filters by view, status, money, ids, sellers, store name, dates, deadline and amount', async () => {
      const a = await add({ minutes: 1, evidenceDueBy: T0.add({ hours: 24 }) });
      const b = await add({
        minutes: 2,
        bucket: 'under-review',
        status: 'under_review',
        inquiry: true,
        amount: money(5000n, currency),
        seller: SELLER_B,
      });
      const c = await add({
        minutes: 3,
        bucket: 'won',
        status: 'won',
        closed: true,
        outcome: 'won',
        fundsWithdrawn: true,
        fundsReinstated: true,
        evidenceDueBy: T0.add({ hours: 72 }),
      });
      const found = async (input: Record<string, unknown>) => ids(must(await list(input)));
      expect(await found({ view: 'won' })).toEqual([c.disputeId]);
      expect(await found({ filter: 'under-review' })).toEqual([b.disputeId]);
      expect(await found({ status: 'needs_response' })).toEqual([a.disputeId]);
      expect(await found({ money: 'inquiry' })).toEqual([b.disputeId]);
      expect(await found({ money: 'reinstated' })).toEqual([c.disputeId]);
      expect(await found({ money: 'none' })).toEqual([a.disputeId]);
      expect(await found({ q: a.disputeId })).toEqual([a.disputeId]);
      expect(await found({ q: b.orderId.toUpperCase() })).toEqual([b.disputeId]);
      expect(await found({ sellerId: SELLER_B })).toEqual([b.disputeId]);
      expect(await found({ search: 'halal' })).toEqual([c.disputeId, a.disputeId]);
      expect(await found({ search: 'halal', sellerId: SELLER_B })).toEqual([]);
      expect(
        await found({
          from: T0.add({ minutes: 2 }).toString(),
          to: T0.add({ minutes: 3 }).toString(),
        }),
      ).toEqual([b.disputeId]);
      expect(await found({ dueBefore: T0.add({ hours: 48 }).toString() })).toEqual([a.disputeId]);
      expect(await found({ minAmount: '3000' })).toEqual([b.disputeId]);
      expect(await found({ maxAmount: '2000' })).toEqual([c.disputeId, a.disputeId]);
      const narrowed = must(await list({ money: 'none' }));
      expect(narrowed.total).toBe(1);
      expect(narrowed.counts.all).toBe(3);
    });

    it('sorts by opened, amount, evidence due (none last) and updated, the id breaking ties', async () => {
      const a = await add({ minutes: 1, amount: money(300n, currency) });
      const b = await add({
        minutes: 1,
        amount: money(300n, currency),
        evidenceDueBy: T0.add({ hours: 5 }),
        updatedAt: T0.add({ hours: 9 }),
      });
      const c = await add({
        minutes: 2,
        amount: money(100n, currency),
        evidenceDueBy: T0.add({ hours: 1 }),
      });
      const sorted = async (sort: string, direction: string) =>
        ids(must(await list({ sort, direction })));
      expect(await sorted('opened', 'desc')).toEqual([c.disputeId, b.disputeId, a.disputeId]);
      expect(await sorted('opened', 'asc')).toEqual([a.disputeId, b.disputeId, c.disputeId]);
      expect(await sorted('amount', 'asc')).toEqual([c.disputeId, a.disputeId, b.disputeId]);
      expect(await sorted('evidence-due', 'asc')).toEqual([c.disputeId, b.disputeId, a.disputeId]);
      expect(await sorted('evidence-due', 'desc')).toEqual([b.disputeId, c.disputeId, a.disputeId]);
      expect((await sorted('updated', 'desc'))[0]).toBe(b.disputeId);
    });

    it("pages in both modes and walks the older panel's cursor newest first", async () => {
      const made = [];
      for (let i = 0; i < 3; i += 1) made.push(await add({ minutes: i + 1 }));
      const second = must(await list({ page: 2, pageSize: 2 }));
      expect(ids(second)).toEqual([made[0]!.disputeId]);
      expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2, nextCursor: null });
      const first = must(await list({ filter: 'needs-response', limit: 2 }));
      expect(ids(first)).toEqual([made[2]!.disputeId, made[1]!.disputeId]);
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
      const rest = must(await list({ limit: 2, cursor: first.nextCursor }));
      expect(ids(rest)).toEqual([made[0]!.disputeId]);
      expect(rest.nextCursor).toBeNull();
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      const refused = await list({
        view: 'open',
        filter: 'won',
        status: 'x',
        money: 'gone',
        q: 'abc',
        search: 'a',
        from: 'yesterday',
        minAmount: '-1',
        sort: 'name',
      });
      expect(refused.ok).toBe(false);
      const paths =
        !refused.ok && 'fields' in refused.error
          ? refused.error.fields.map((f) => f.path).sort()
          : [];
      expect(paths).toEqual([
        'filter',
        'from',
        'minAmount',
        'money',
        'q',
        'search',
        'sort',
        'status',
        'view',
      ]);
      expect(await list({ cursor: 'nope', sort: 'amount', limit: 0 })).toMatchObject({
        ok: false,
        error: {
          fields: [
            { path: 'sort', code: 'with-cursor' },
            { path: 'limit', code: 'range' },
            { path: 'cursor', code: 'format' },
          ],
        },
      });
      expect(await list({ page: 500, pageSize: 100 })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'page', code: 'too-deep' }] },
      });
      expect(reader.reads).toBe(0);
    });

    it('fails closed when the store search fails, says when it was capped, degrades names', async () => {
      await add({});
      search.failing = true;
      const logged = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      try {
        expect(await list({ search: 'secret-term-7q' })).toEqual({
          ok: false,
          error: { code: 'commission-payouts.search-unavailable' },
        });
        // A valid `q` with the failing search reaches the logged failure too.
        const q = id<'Order'>(0x7e57);
        expect(await list({ q, search: 'secret-term-7q' })).toMatchObject({ ok: false });
        expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(q);
        // The failure is logged, and neither the search term nor `q` is in what was logged.
        const calls = logged.flatMap((spy) => spy.mock.calls);
        expect(calls.length).toBeGreaterThan(0);
        expect(JSON.stringify(calls)).not.toContain('secret-term-7q');
      } finally {
        for (const spy of logged) spy.mockRestore();
      }
      expect(reader.reads).toBe(0);
      search.failing = false;
      search.capped = true;
      expect(must(await list({ search: 'halal' })).searchCapped).toBe(true);
      names.unavailable = true;
      expect(must(await list({})).disputes[0]!.sellers).toEqual([
        { sellerId: SELLER_A, storeName: null },
      ]);
    });

    it('refuses a seller filter or store search that matches too many disputed orders', async () => {
      await add({});
      const asked: number[] = [];
      reader.disputedOrdersOfSellers = (_m, _sellers, limit) => {
        asked.push(limit);
        return Promise.resolve(Array.from({ length: limit }, (_, i) => id<'Order'>(0x100000 + i)));
      };
      expect(await list({ search: 'halal' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'search', code: 'too-broad' }] },
      });
      expect(await list({ sellerId: SELLER_A })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'sellerId', code: 'too-broad' }] },
      });
      expect(await exportAdminDisputes(deps, admin, { search: 'halal' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'search', code: 'too-broad' }] },
      });
      expect(await exportAdminDisputes(deps, admin, { sellerId: SELLER_A })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'sellerId', code: 'too-broad' }] },
      });
      expect(asked).toEqual([1, 1, 1, 1].map(() => DISPUTE_SELLER_ORDERS_MAX + 1));
      // At the cap itself the list is read.
      reader.disputedOrdersOfSellers = (_m, _sellers, limit) =>
        Promise.resolve(Array.from({ length: limit - 1 }, (_, i) => id<'Order'>(0x100000 + i)));
      expect(must(await list({ sellerId: SELLER_A })).disputes).toEqual([]);
    });

    it('is for admins of the Market only', async () => {
      await add({});
      expect(await list({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(must(await list({}, actorOf(otherMarket, 'admin'))).disputes).toEqual([]);
    });
  });

  describe('the export', () => {
    const exportOf = (input: Record<string, unknown>, context: CallContext = admin) =>
      exportAdminDisputes(deps, context, input);

    it("writes what the list shows in the panel's words, extra columns in the order asked", async () => {
      const due = T0.add({ hours: 30 });
      const a = await add({ minutes: 1, evidenceDueBy: due, amount: money(12345n, currency) });
      const b = await add({
        minutes: 2,
        bucket: 'decision-needed',
        status: 'lost',
        closed: true,
        outcome: 'lost',
        fundsWithdrawn: true,
        reason: 'product_not_received',
        seller: SELLER_B,
      });
      await sell(b.orderId, SELLER_A);
      await add({}, otherMarket);
      const file = must(await exportOf({ columns: 'money,evidence-due,reason,seller-ids' }));
      expect(file).toMatchObject({
        filename: 'disputes-2026-11-02.csv',
        contentType: 'text/csv; charset=utf-8',
      });
      const lines = await linesOf(file);
      expect(lines[0]).toBe(
        '﻿Dispute ID,Order ID,Sellers,Stage,Amount,Currency,Opened (UTC),Money,Evidence due (UTC),Reason,Seller IDs',
      );
      const amount = currency === 'AUD' ? '123.45' : '12345';
      expect(lines.slice(1)).toEqual([
        `${b.disputeId},${b.orderId},Spice Lane; Halal Corner,Decision needed,${currency === 'AUD' ? '20.00' : '2000'},${currency},${b.openedAt.toString()},Taken by bank,,product_not_received,${SELLER_B}; ${SELLER_A}`,
        `${a.disputeId},${a.orderId},Halal Corner,Needs response,${amount},${currency},${a.openedAt.toString()},None,${due.toString()},fraudulent,${SELLER_A}`,
      ]);
      expect(lines.join('\n')).not.toContain('dp_secret');
      expect(await linesOf(must(await exportOf({ view: 'decision-needed' })))).toHaveLength(2);
      expect(
        (await linesOf(must(await exportOf({ sort: 'opened', direction: 'asc' }))))
          .slice(1)
          .map((line) => line.split(',')[0]),
      ).toEqual([a.disputeId, b.disputeId]);
    });

    it('writes the chosen rows in the order given; a case of another Market refuses the file', async () => {
      const a = await add({ minutes: 1 });
      const b = await add({ minutes: 2 });
      const foreign = await add({}, otherMarket);
      const lines = await linesOf(must(await exportOf({ ids: `${a.disputeId},${b.disputeId}` })));
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([a.disputeId, b.disputeId]);
      expect(await exportOf({ ids: `${a.disputeId},${foreign.disputeId}` })).toEqual({
        ok: false,
        error: { code: 'commission-payouts.dispute-not-found' },
      });
    });

    it('refuses more than 10,000 rows, a capped store search, an unknown key and a seller', async () => {
      for (let i = 0; i < 3; i += 1) await add({ minutes: i + 1 });
      const many = reader.idsPage.bind(reader);
      reader.idsPage = async (m, f, s) => {
        const real = await many(m, f, s, 3);
        return Array.from({ length: 10_001 }, (_, i) => real[i % real.length]!);
      };
      reader.count = () => Promise.resolve(12_000);
      expect(await exportOf({})).toMatchObject({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 12_000 },
      });
      search.capped = true;
      expect(await exportOf({ search: 'halal' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'search', code: 'too-broad' }] },
      });
      expect(await exportOf({ cursor: 'x' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'cursor', code: 'unknown' }] },
      });
      expect(await exportOf({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('writes an XLSX file where every cell is a string and a formula-like name is inert', async () => {
      names.names.set(SELLER_A, '=1+2');
      await add({});
      const file = must(await exportOf({ format: 'xlsx', columns: 'stripe-status' }));
      expect(file.filename).toBe('disputes-2026-11-02.xlsx');
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.chunks) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
      const sheet = book.worksheets[0]!;
      expect(sheet.name).toBe('Disputes');
      expect(sheet.getRow(1).getCell(8).value).toBe('Bank status');
      expect(sheet.getRow(2).getCell(3).value).toBe('=1+2');
      expect(sheet.getRow(2).getCell(3).formula).toBeUndefined();
      sheet.getRow(2).eachCell((cell) => expect(typeof cell.value).toBe('string'));
      const csv = await linesOf(must(await exportOf({})));
      expect(csv[1]!.split(',')[2]).toBe("'=1+2");
    });
  });
});

import ExcelJS from 'exceljs';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ScriptedProbe } from '../../../../test/support/commission-payouts-list-fakes';
import { MemorySellerPageLists } from '../../../../test/support/commission-payouts-seller-page-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { LedgerEntry, LedgerKind } from '../domain/ledger';
import type { CommissionPolicy } from './ports/commission-policy';
import type { LedgerRepository } from './ports/ledger.repository';
import type { PayoutHoldRecord } from './ports/payout-hold.repository';
import {
  exportSellerHolds,
  exportSellerLedger,
  HOLD_ROW_KEYS,
  listSellerHolds,
  listSellerLedger,
  type SellerPageListDependencies,
} from './seller-page-lists-flow';

// The seller page's compact super lists (phase 4, lists 27 and 28) and their exports, on both
// Market fixtures: AU in AUD (two minor digits), ZZ in JPY (none). Reads only.

const FIXTURES = { AU: { currency: 'AUD' }, ZZ: { currency: 'JPY' } } as const;
const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x51);
const OTHER_SELLER = id<'Seller'>(0x52);
const GHOST = id<'Seller'>(0x5f);

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

async function linesOf(file: ExportFile): Promise<string[]> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
}

describe.each([['AU'], ['ZZ']] as const)('the seller page lists in market %s', (code) => {
  const { currency } = FIXTURES[code];
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const actorOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id<'Account'>(population === 'admin' ? 0xad : 0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? SELLER : null,
      }),
      `cp-${population}-seller-page`,
    );
  const admin = actorOf('admin');

  let ledger: Map<string, LedgerEntry[]>;
  let holds: Map<string, PayoutHoldRecord[]>;
  let lists: MemorySellerPageLists;
  let release: ScriptedProbe;
  let sellerKnown: boolean | 'unavailable';
  let deps: SellerPageListDependencies;
  let n: number;

  beforeEach(() => {
    ledger = new Map();
    holds = new Map();
    lists = new MemorySellerPageLists(
      (m: MarketContext) => ledger.get(m.marketId) ?? [],
      (m: MarketContext) => holds.get(m.marketId) ?? [],
    );
    release = new ScriptedProbe(true);
    sellerKnown = true;
    const policy: CommissionPolicy = {
      settings: (m) => ({ currency: FIXTURES[m.marketId as 'AU' | 'ZZ'].currency }) as never,
    };
    const sums: Pick<LedgerRepository, 'sums'> = {
      sums: (m, sellerId) => {
        const byKind = new Map<LedgerKind, bigint>();
        for (const entry of ledger.get(m.marketId) ?? []) {
          if (entry.sellerId !== sellerId) continue;
          byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0n) + entry.amount.amount);
        }
        return Promise.resolve(
          [...byKind.entries()].map(([kind, amount]) => ({ currency, kind, amount })),
        );
      },
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      ledger: sums as LedgerRepository,
      lists,
      policy,
      sellers: { exists: () => Promise.resolve(sellerKnown) },
      probes: { [HOLD_ROW_KEYS[0]]: release },
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(T0),
    };
    n = 0;
  });

  const entry = (
    fields: Partial<LedgerEntry> & { readonly minutes?: number; readonly value?: bigint },
    m: MarketContext = market,
  ): LedgerEntry => {
    n += 1;
    const at = T0.add({ minutes: fields.minutes ?? n });
    const row: LedgerEntry = {
      id: id<'LedgerEntry'>(0x1000 + n),
      sellerId: SELLER,
      orderId: id<'Order'>(0x2000 + n),
      sellerOrderId: id<'SellerOrder'>(0x3000 + n),
      orderLineId: id<'OrderLine'>(0x4000 + n),
      kind: 'sale',
      amount: money(fields.value ?? 1000n, FIXTURES[m.marketId as 'AU' | 'ZZ'].currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
      occurredAt: at,
      recordedAt: at,
      ...fields,
    };
    ledger.set(m.marketId, [...(ledger.get(m.marketId) ?? []), row]);
    return row;
  };

  const hold = (
    fields: Partial<PayoutHoldRecord> & { readonly minutes?: number },
  ): PayoutHoldRecord => {
    n += 1;
    const holdId = id<'PayoutHold'>(0x5000 + n);
    const row: PayoutHoldRecord = {
      id: holdId,
      sellerId: SELLER,
      sellerOrderId: null,
      reason: 'admin-review',
      origin: 'admin',
      sourceRef: holdId,
      placedBy: id<'Account'>(0xad),
      placedAt: T0.add({ minutes: fields.minutes ?? n }),
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      ...fields,
    };
    holds.set(market.marketId, [...(holds.get(market.marketId) ?? []), row]);
    return row;
  };

  describe('the ledger (27)', () => {
    const list = (input: Record<string, unknown>, context: CallContext = admin) =>
      listSellerLedger(deps, context, { sellerId: SELLER, ...input });
    const ids = (page: { entries: readonly { entryId: string }[] }) =>
      page.entries.map((row) => row.entryId);

    it('lists the seller rows newest first, 25 to a page, with the balance over every row', async () => {
      const sale = entry({ value: 1000n });
      const fee = entry({ kind: 'commission', value: 150n, rateBps: 1500, baseAmount: 1000n });
      entry({ sellerId: OTHER_SELLER });
      entry({}, otherMarket);
      const page = must(await list({}));
      expect(ids(page)).toEqual([fee.id, sale.id]);
      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 25, nextCursor: null, currency });
      expect(page.totals).toMatchObject({ sales: 1000n, commission: 150n, balance: 850n });
      expect(page.entries[0]).toMatchObject({ direction: 'debit', actions: ['open-order'] });
      // A filter narrows the rows, never the balance.
      const narrow = must(await list({ kind: 'sale' }));
      expect(ids(narrow)).toEqual([sale.id]);
      expect(narrow.totals.balance).toBe(850n);
    });

    it('filters by kind, side, an order or seller order id, the recorded time and the amount', async () => {
      const sale = entry({ value: 1000n, minutes: 1 });
      const refund = entry({ kind: 'refund-sale', value: 300n, minutes: 2 });
      const fee = entry({ kind: 'commission', value: 150n, minutes: 3 });
      const of = async (input: Record<string, unknown>) => ids(must(await list(input)));
      expect(await of({ side: 'debit' })).toEqual([fee.id, refund.id]);
      expect(await of({ side: 'credit' })).toEqual([sale.id]);
      expect(await of({ side: 'credit', kind: 'commission' })).toEqual([]);
      expect(await of({ q: sale.orderId })).toEqual([sale.id]);
      expect(await of({ q: refund.sellerOrderId.toUpperCase() })).toEqual([refund.id]);
      expect(await of({ from: T0.add({ minutes: 2 }).toString() })).toEqual([fee.id, refund.id]);
      expect(await of({ to: T0.add({ minutes: 2 }).toString() })).toEqual([sale.id]);
      expect(await of({ minAmount: '200', maxAmount: '999' })).toEqual([refund.id]);
    });

    it('sorts by amount, occurrence and record with the id breaking ties, in both directions', async () => {
      const tied = [0, 1, 2].map(() => entry({ value: 500n, minutes: 5 }));
      const asc = tied.map((row) => row.id);
      for (const sort of ['recorded', 'occurred', 'amount']) {
        expect(ids(must(await list({ sort, direction: 'asc' })))).toEqual(asc);
        expect(ids(must(await list({ sort, direction: 'desc' })))).toEqual([...asc].reverse());
      }
      const low = entry({ value: 1n, minutes: 9 });
      expect(ids(must(await list({ sort: 'amount', direction: 'asc' })))[0]).toBe(low.id);
    });

    it('walks Previous and Next as the older card asks, 50 rows by default', async () => {
      const made = [0, 1, 2, 3, 4].map(() => entry({ minutes: 1 }));
      const first = must(await list({ limit: 2 }));
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
      const second = must(await list({ limit: 2, cursor: first.nextCursor }));
      const third = must(await list({ limit: 2, cursor: second.nextCursor, side: 'credit' }));
      expect(third.nextCursor).toBeNull();
      expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(
        made.map((row) => row.id).reverse(),
      );
      expect(must(await list({ cursor: first.nextCursor })).pageSize).toBe(50);
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      const answer = await list({
        kind: 'tip',
        side: 'both',
        q: 'not-an-id',
        from: '2026-11-02',
        minAmount: '-1',
        sort: 'store',
        direction: 'up',
        pageSize: 101,
        extra: '1',
      });
      expect(answer).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: expect.arrayContaining([
            { path: 'extra', code: 'unknown' },
            { path: 'kind', code: 'value' },
            { path: 'side', code: 'value' },
            { path: 'q', code: 'format' },
            { path: 'from', code: 'format' },
            { path: 'minAmount', code: 'format' },
            { path: 'pageSize', code: 'range' },
            { path: 'sort', code: 'value' },
            { path: 'direction', code: 'value' },
          ]) as unknown,
        },
      });
      expect(await list({ limit: 2, sort: 'amount', page: 1 })).toMatchObject({
        error: {
          fields: [
            { path: 'page', code: 'with-cursor' },
            { path: 'sort', code: 'with-cursor' },
          ],
        },
      });
      for (const limit of [0, 101]) {
        expect(await list({ limit })).toMatchObject({
          error: { fields: [{ path: 'limit', code: 'range' }] },
        });
      }
      expect(await list({ cursor: 'nope' })).toMatchObject({
        error: { fields: [{ path: 'cursor', code: 'format' }] },
      });
      expect(await list({ page: 101, pageSize: 100 })).toMatchObject({
        error: { fields: [{ path: 'page', code: 'too-deep' }] },
      });
      expect(await list({ minAmount: '9', maxAmount: '1' })).toMatchObject({
        error: { fields: [{ path: 'maxAmount', code: 'range' }] },
      });
      expect(lists.reads).toBe(0);
    });

    it('is for admins only, and needs a seller id', async () => {
      expect(await list({}, actorOf('seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await listSellerLedger(deps, admin, { sellerId: 'x' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] },
      });
      expect(lists.reads).toBe(0);
    });

    describe('the export', () => {
      const exportOf = (input: Record<string, unknown>, context: CallContext = admin) =>
        exportSellerLedger(deps, context, { sellerId: SELLER, ...input });

      it('writes the rows the list shows, amounts as decimals of the currency, extra columns in the order asked', async () => {
        const sale = entry({ value: 1234n, minutes: 1 });
        const fee = entry({
          kind: 'commission',
          value: 150n,
          rateBps: 1500,
          baseAmount: 1000n,
          minutes: 2,
        });
        entry({ sellerId: OTHER_SELLER });
        const file = must(await exportOf({ columns: 'rate,base,entry-id' }));
        expect(file.filename).toBe('seller-ledger-2026-11-02.csv');
        const lines = await linesOf(file);
        expect(lines[0]).toBe(
          'Recorded,Kind,Direction,Amount,Currency,Order ID,Seller order ID,Rate (bps),Base,Entry ID',
        );
        const [feeText, baseText, saleText] =
          code === 'AU' ? ['1.50', '10.00', '12.34'] : ['150', '1000', '1234'];
        expect(lines[1]).toBe(
          `${fee.recordedAt.toString()},Commission,Debit,${feeText},${currency},${fee.orderId},${fee.sellerOrderId},1500,${baseText},${fee.id}`,
        );
        expect(lines[2]).toBe(
          `${sale.recordedAt.toString()},Sale,Credit,${saleText},${currency},${sale.orderId},${sale.sellerOrderId},,,${sale.id}`,
        );
        expect(lines).toHaveLength(3);
      });

      it('writes the chosen rows in the order given and refuses a row of another seller or Market', async () => {
        const a = entry({});
        const b = entry({});
        const theirs = entry({ sellerId: OTHER_SELLER });
        const elsewhere = entry({}, otherMarket);
        const lines = await linesOf(must(await exportOf({ ids: `${a.id},${b.id}` })));
        expect(lines.slice(1).map((line) => line.split(',').at(-1))).toHaveLength(2);
        expect(lines[1]).toContain(a.orderId);
        expect(lines[2]).toContain(b.orderId);
        for (const other of [theirs, elsewhere]) {
          expect(await exportOf({ ids: `${a.id},${other.id}` })).toEqual({
            ok: false,
            error: { code: 'commission-payouts.ledger-entry-not-found' },
          });
        }
      });

      it('refuses more than 10,000 rows whole with the total, a key it does not know, and a non-admin', async () => {
        lists.ledgerIds = () =>
          Promise.resolve(Array.from({ length: 10_001 }, (_, i) => id<'LedgerEntry'>(0x9000 + i)));
        lists.ledgerCount = () => Promise.resolve(12_000);
        expect(await exportOf({})).toEqual({
          ok: false,
          error: { code: 'batch.too-large', max: 10_000, total: 12_000 },
        });
        expect(await exportOf({ page: '2' })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
        });
        expect(
          await exportOf({ ids: Array.from({ length: 201 }, (_, i) => id(i)).join(',') }),
        ).toEqual({
          ok: false,
          error: { code: 'batch.too-large', max: 200 },
        });
        expect(await exportOf({}, actorOf('seller'))).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      });

      it('writes an XLSX file where every cell is a string', async () => {
        entry({ value: 1234n });
        const file = must(await exportOf({ format: 'xlsx' }));
        expect(file.filename).toBe('seller-ledger-2026-11-02.xlsx');
        const parts: Uint8Array[] = [];
        for await (const chunk of file.chunks) {
          parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
        const row = book.worksheets[0]!.getRow(2);
        expect(row.getCell(4).value).toBe(code === 'AU' ? '12.34' : '1234');
        expect(row.getCell(4).type).toBe(ExcelJS.ValueType.String);
      });
    });
  });

  describe('the payout holds (28)', () => {
    const list = (input: Record<string, unknown>, context: CallContext = admin) =>
      listSellerHolds(deps, context, { sellerId: SELLER, ...input });
    const ids = (page: { holds: readonly { holdId: string }[] }) =>
      page.holds.map((row) => row.holdId);
    const released = (minutes: number) => ({
      releasedAt: T0.add({ minutes }),
      releasedBy: id<'Account'>(0xad),
      releaseReason: 'resolved' as const,
    });

    it('lists active holds first, then the newest, 100 to a page, with the counts per status', async () => {
      const oldActive = hold({ minutes: 1 });
      const releasedHold = hold({ minutes: 5, ...released(10) });
      const newActive = hold({ minutes: 3, sellerOrderId: id<'SellerOrder'>(0x301) });
      hold({ sellerId: OTHER_SELLER });
      const page = must(await list({}));
      expect(ids(page)).toEqual([newActive.id, oldActive.id, releasedHold.id]);
      expect(page).toMatchObject({
        counts: { active: 2, released: 1 },
        total: 3,
        page: 1,
        pageSize: 100,
        nextCursor: null,
      });
      expect(page.holds.map((row) => row.actions)).toEqual([
        ['open-order', 'release'],
        ['release'],
        [],
      ]);
    });

    it('offers Release only to a caller who holds the key; a failing probe offers nothing', async () => {
      hold({ sellerOrderId: id<'SellerOrder'>(0x301) });
      release.held = false;
      expect(must(await list({})).holds[0]!.actions).toEqual(['open-order']);
      release.execute = () => Promise.reject(new Error('down'));
      expect(must(await list({})).holds[0]!.actions).toEqual(['open-order']);
    });

    it('filters by status, reason, origin, scope, seller order and placement time', async () => {
      const order = id<'SellerOrder'>(0x301);
      const admin1 = hold({ minutes: 1 });
      const system = hold({
        minutes: 2,
        origin: 'system',
        reason: 'seller-suspended',
        placedBy: null,
      });
      const onOrder = hold({
        minutes: 3,
        sellerOrderId: order,
        reason: 'refund-pending',
        origin: 'system',
        placedBy: null,
      });
      const done = hold({ minutes: 4, ...released(9) });
      const of = async (input: Record<string, unknown>) => ids(must(await list(input)));
      expect(await of({ status: 'released' })).toEqual([done.id]);
      expect(await of({ status: 'active', sort: 'placed' })).toEqual([
        onOrder.id,
        system.id,
        admin1.id,
      ]);
      expect(await of({ reason: 'seller-suspended' })).toEqual([system.id]);
      expect(await of({ origin: 'admin', sort: 'placed', direction: 'asc' })).toEqual([
        admin1.id,
        done.id,
      ]);
      expect(await of({ scope: 'order' })).toEqual([onOrder.id]);
      expect(await of({ sellerOrderId: order })).toEqual([onOrder.id]);
      expect(await of({ scope: 'seller', sellerOrderId: order })).toEqual([]);
      expect(await of({ from: T0.add({ minutes: 3 }).toString(), sort: 'placed' })).toEqual([
        done.id,
        onOrder.id,
      ]);
      expect(await of({ sort: 'released', direction: 'desc' })).toEqual(
        expect.arrayContaining([done.id]) as unknown,
      );
      expect((await of({ sort: 'released', direction: 'desc' }))[0]).toBe(done.id);
    });

    it('walks Previous and Next newest placement first', async () => {
      const made = [0, 1, 2].map(() => hold({ minutes: 1 }));
      const first = must(await list({ limit: 2 }));
      const second = must(await list({ limit: 2, cursor: first.nextCursor }));
      expect(second.nextCursor).toBeNull();
      expect([...ids(first), ...ids(second)]).toEqual(made.map((row) => row.id).reverse());
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
    });

    it('refuses an unknown or unreadable seller, a non-admin and a bad query, before reading', async () => {
      expect(
        await list({ status: 'lost', reason: 'x', scope: 'all', sellerOrderId: 'x' }),
      ).toMatchObject({
        error: {
          fields: [
            { path: 'status', code: 'value' },
            { path: 'reason', code: 'value' },
            { path: 'scope', code: 'value' },
            { path: 'sellerOrderId', code: 'format' },
          ],
        },
      });
      sellerKnown = false;
      expect(await listSellerHolds(deps, admin, { sellerId: GHOST })).toEqual({
        ok: false,
        error: { code: 'commission-payouts.seller-not-found' },
      });
      sellerKnown = 'unavailable';
      expect(await list({})).toEqual({
        ok: false,
        error: { code: 'commission-payouts.unavailable' },
      });
      expect(await list({}, actorOf('seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(lists.reads).toBe(0);
    });

    describe('the export', () => {
      const exportOf = (input: Record<string, unknown>) =>
        exportSellerHolds(deps, admin, { sellerId: SELLER, ...input });

      it("writes the holds in the panel's words, in the list's order", async () => {
        const order = id<'SellerOrder'>(0x301);
        const active = hold({
          minutes: 1,
          sellerOrderId: order,
          reason: 'dispute',
          origin: 'system',
          placedBy: null,
        });
        const done = hold({ minutes: 2, ...released(5) });
        const lines = await linesOf(must(await exportOf({ columns: 'hold-id,release-reason' })));
        expect(lines[0]).toBe(
          'Placed,Status,Reason,Placed by,Covers,Seller order ID,Released,Hold ID,Release reason',
        );
        expect(lines[1]).toBe(
          `${active.placedAt.toString()},Active,Payment disputed,System,One seller order,${order},,${active.id},`,
        );
        expect(lines[2]).toBe(
          `${done.placedAt.toString()},Released,Admin review,Admin,The whole seller,,${T0.add({ minutes: 5 }).toString()},${done.id},Resolved`,
        );
      });

      it('refuses a hold of another seller, an unknown seller, and more than 10,000 holds', async () => {
        const mine = hold({});
        const theirs = hold({ sellerId: OTHER_SELLER });
        expect(await exportOf({ ids: `${mine.id},${theirs.id}` })).toEqual({
          ok: false,
          error: { code: 'commission-payouts.hold-not-found' },
        });
        lists.holdIds = () =>
          Promise.resolve(Array.from({ length: 10_001 }, (_, i) => id<'PayoutHold'>(0x9000 + i)));
        lists.holdCount = () => Promise.resolve(10_500);
        expect(await exportOf({})).toEqual({
          ok: false,
          error: { code: 'batch.too-large', max: 10_000, total: 10_500 },
        });
        sellerKnown = false;
        expect(await exportOf({})).toEqual({
          ok: false,
          error: { code: 'commission-payouts.seller-not-found' },
        });
      });
    });
  });
});

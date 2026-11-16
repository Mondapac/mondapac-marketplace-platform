import ExcelJS from 'exceljs';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAdminPayoutList } from '../../../../test/support/commission-payouts-list-fakes';
import { MemoryPayouts } from '../../../../test/support/commission-payouts-payout-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { Payout, PayoutState } from '../domain/payout';
import {
  exportOwnPayouts,
  listOwnPayoutPage,
  type OwnPayoutListDependencies,
  type OwnPayoutListPage,
} from './own-payout-list-flow';

// The seller panel's Earnings › Payouts super list (phase 4, list 33) and its export, on both
// Market fixtures: AU in AUD (two minor digits), ZZ in JPY (none). The seller is always the
// session's; another seller's and a voided payout never show. Nothing here moves money.

const FIXTURES = { AU: { currency: 'AUD' }, ZZ: { currency: 'JPY' } } as const;
const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MINE = id<'Seller'>(0x51);
const THEIRS = id<'Seller'>(0x52);

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

describe.each([['AU'], ['ZZ']] as const)('the seller Payouts list in market %s', (code) => {
  const { currency } = FIXTURES[code];
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const actorOf = (m: MarketContext, population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population,
        accountId: id<'Account'>(population === 'admin' ? 0xad : 0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? MINE : null,
      }),
      `cp-${population}-own-list`,
    );
  const seller = actorOf(market, 'seller');

  let payouts: MemoryPayouts;
  let reader: MemoryAdminPayoutList;
  let deps: OwnPayoutListDependencies;
  let n: number;

  beforeEach(() => {
    payouts = new MemoryPayouts();
    reader = new MemoryAdminPayoutList(payouts);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      payouts: reader,
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(T0),
    };
    n = 0;
  });

  /** A stored payout of the Market, created `minutes` after T0. */
  const add = (
    fields: Partial<Payout> & { readonly minutes?: number },
    m: MarketContext = market,
  ): Payout => {
    n += 1;
    const at = T0.add({ minutes: fields.minutes ?? n });
    const { minutes, ...rest } = fields;
    void minutes;
    const payout: Payout = {
      id: id<'Payout'>(0x1000 + n),
      sellerId: MINE,
      currency: FIXTURES[m.marketId as 'AU' | 'ZZ'].currency,
      gross: 10000n,
      netted: 0n,
      transfer: 10000n,
      approvalMode: 'AUTO',
      approvalReason: null,
      minimum: 5000n,
      slotAt: at,
      state: 'paid',
      approval: null,
      transferExecutionId: null,
      outcomeCode: null,
      instructingAt: null,
      abandonedAt: null,
      createdAt: at,
      stateChangedAt: at,
      version: 1,
      ...rest,
    };
    payouts.rows.set(`${m.marketId}:${payout.id}`, payout);
    return payout;
  };
  const list = (input: Record<string, unknown>, context: CallContext = seller) =>
    listOwnPayoutPage(deps, context, input);
  const ids = (page: OwnPayoutListPage) => page.payouts.map((row) => row.payoutId);

  describe('reading', () => {
    it('answers page numbers by default: own payouts newest first, 25 a page, voided hidden, counts per status', async () => {
      const states: PayoutState[] = [
        'pending',
        'approved',
        'awaiting-approval',
        'instructing',
        'instructed',
        'paid',
        'failed',
        'not-sent',
        'settled-by-netting',
      ];
      const mine = states.map((state) => add({ state }));
      add({ state: 'voided' });
      add({ sellerId: THEIRS });
      add({}, otherMarket);
      const page = must(await list({}));
      expect(ids(page)).toEqual(mine.map((p) => p.id).reverse());
      expect(page).toMatchObject({ total: 9, page: 1, pageSize: 25, nextCursor: null });
      expect(page.counts).toEqual({
        all: 9,
        scheduled: 2,
        'awaiting-approval': 1,
        'on-its-way': 2,
        paid: 1,
        'not-sent': 1,
        failed: 1,
        settled: 1,
      });
      expect(page.payouts[0]).toMatchObject({
        status: 'settled',
        transfer: { currency },
        actions: ['open'],
      });
    });

    it('filters by status, payout id, created time and amount; a filter never changes the counts', async () => {
      const paid = add({ state: 'paid', transfer: 300n, minutes: 1 });
      const sending = add({ state: 'instructing', transfer: 700n, minutes: 2 });
      const sent = add({ state: 'instructed', transfer: 900n, minutes: 3 });
      add({ state: 'voided', minutes: 4 });
      const of = async (input: Record<string, unknown>) => ids(must(await list(input)));
      expect(await of({ status: 'on-its-way' })).toEqual([sent.id, sending.id]);
      expect(await of({ status: 'paid' })).toEqual([paid.id]);
      expect(await of({ q: sending.id.toUpperCase() })).toEqual([sending.id]);
      expect(await of({ from: T0.add({ minutes: 2 }).toString() })).toEqual([sent.id, sending.id]);
      expect(await of({ to: T0.add({ minutes: 2 }).toString() })).toEqual([paid.id]);
      expect(await of({ minAmount: '500', maxAmount: '800' })).toEqual([sending.id]);
      const narrow = must(await list({ status: 'paid' }));
      expect(narrow.total).toBe(1);
      expect(narrow.counts).toMatchObject({ all: 3, paid: 1, 'on-its-way': 2 });
    });

    it('sorts by created, amount and slot with the id breaking ties, in both directions', async () => {
      const tied = [0, 1, 2].map(() => add({ transfer: 500n, minutes: 5 }));
      const asc = tied.map((p) => p.id);
      for (const sort of ['created', 'amount', 'slot']) {
        expect(ids(must(await list({ sort, direction: 'asc' })))).toEqual(asc);
        expect(ids(must(await list({ sort, direction: 'desc' })))).toEqual([...asc].reverse());
      }
      const late = add({ minutes: 1, slotAt: T0.add({ hours: 216 }), transfer: 1n });
      expect(ids(must(await list({ sort: 'slot', direction: 'desc' })))[0]).toBe(late.id);
      expect(ids(must(await list({ sort: 'amount', direction: 'asc' })))[0]).toBe(late.id);
    });

    it('walks Previous and Next as the older Earnings card asks, 50 rows by default', async () => {
      const made = [0, 1, 2, 3, 4].map(() => add({ minutes: 1 }));
      const newest = made.map((p) => p.id).reverse();
      const first = must(await list({ limit: 2 }));
      expect(ids(first)).toEqual(newest.slice(0, 2));
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
      const second = must(await list({ limit: 2, cursor: first.nextCursor }));
      expect(ids(second)).toEqual(newest.slice(2, 4));
      const last = must(await list({ limit: 2, cursor: second.nextCursor }));
      expect(ids(last)).toEqual(newest.slice(4));
      expect(last.nextCursor).toBeNull();
      expect(must(await list({ cursor: first.nextCursor })).pageSize).toBe(50);
    });

    it('walks Previous and Next inside a filter, never leaving it', async () => {
      const paid = [0, 1, 2].map(() => add({ state: 'paid', minutes: 1 }));
      [0, 1].map(() => add({ state: 'failed', minutes: 1 }));
      const newest = paid.map((p) => p.id).reverse();
      const first = must(await list({ status: 'paid', limit: 2 }));
      expect(ids(first)).toEqual(newest.slice(0, 2));
      const next = must(await list({ status: 'paid', limit: 2, cursor: first.nextCursor }));
      expect(ids(next)).toEqual(newest.slice(2));
      expect(next.nextCursor).toBeNull();
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      const refused = await list({
        status: 'voided',
        q: 'x',
        sort: 'fee',
        minAmount: '-1',
        sellerId: THEIRS,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('validation.failed');
      const paths =
        'fields' in refused.error ? refused.error.fields.map((field) => field.path).sort() : [];
      expect(paths).toEqual(['minAmount', 'q', 'sellerId', 'sort', 'status']);
      expect(reader.reads).toBe(0);
    });

    it('is for a seller only: an admin or nobody is refused before reading', async () => {
      add({});
      expect(await list({}, actorOf(market, 'admin'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(reader.reads).toBe(0);
    });
  });

  describe('the export', () => {
    const exportOf = (input: Record<string, unknown>, context: CallContext = seller) =>
      exportOwnPayouts(deps, context, input);

    it('writes what the list shows in the panel words, amounts as decimals, extra columns in the order asked', async () => {
      const paid = add({ state: 'paid', transfer: 12345n, gross: 12345n, minutes: 1 });
      const settled = add({ state: 'settled-by-netting', transfer: 0n, minutes: 2 });
      add({ state: 'voided', minutes: 3 });
      add({ sellerId: THEIRS, minutes: 4 });
      const file = must(await exportOf({ columns: 'slot,gross' }));
      expect(file).toMatchObject({
        filename: 'payouts-2026-11-02.csv',
        contentType: 'text/csv; charset=utf-8',
      });
      const lines = await linesOf(file);
      expect(lines[0]).toBe('﻿Payout ID,Status,Amount,Currency,Created,Planned for,Earned');
      const decimal = code === 'AU' ? '123.45' : '12345';
      expect(lines.slice(1)).toEqual([
        `${settled.id},Settled against what you owe,0${code === 'AU' ? '.00' : ''},${currency},${settled.createdAt.toString()},${settled.slotAt.toString()},${code === 'AU' ? '100.00' : '10000'}`,
        `${paid.id},Paid,${decimal},${currency},${paid.createdAt.toString()},${paid.slotAt.toString()},${decimal}`,
      ]);
      expect(await linesOf(must(await exportOf({ status: 'paid' })))).toHaveLength(2);
    });

    it("writes the selector's rows in the list's sort and direction", async () => {
      const small = add({ transfer: 100n, minutes: 3 });
      const big = add({ transfer: 900n, minutes: 1 });
      const mid = add({ transfer: 500n, minutes: 2 });
      const order = async (input: Record<string, unknown>) =>
        (await linesOf(must(await exportOf(input)))).slice(1).map((line) => line.split(',')[0]);
      expect(await order({})).toEqual([small.id, mid.id, big.id]);
      expect(await order({ sort: 'amount', direction: 'asc' })).toEqual([small.id, mid.id, big.id]);
      expect(await order({ sort: 'amount', direction: 'desc' })).toEqual([big.id, mid.id, small.id]);
      expect(await order({ sort: 'created', direction: 'asc' })).toEqual([big.id, mid.id, small.id]);
    });

    it('writes the chosen rows in the order given; a voided payout, another seller or Market refuses the whole file', async () => {
      const a = add({});
      const b = add({});
      const voided = add({ state: 'voided' });
      const theirs = add({ sellerId: THEIRS });
      const elsewhere = add({}, otherMarket);
      const lines = await linesOf(must(await exportOf({ ids: `${b.id},${a.id}` })));
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([b.id, a.id]);
      for (const other of [voided, theirs, elsewhere]) {
        expect(await exportOf({ ids: `${a.id},${other.id}` })).toEqual({
          ok: false,
          error: { code: 'commission-payouts.payout-not-found' },
        });
      }
    });

    it('refuses more than 10,000 rows whole with the total, a key it does not know, and an admin', async () => {
      reader.idsPage = () =>
        Promise.resolve(Array.from({ length: 10_001 }, (_, i) => id<'Payout'>(0x9000 + i)));
      reader.count = () => Promise.resolve(12_000);
      expect(await exportOf({})).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 12_000 },
      });
      expect(await exportOf({ page: '2' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(await exportOf({}, actorOf(market, 'admin'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('writes an XLSX file where every cell is a string', async () => {
      add({ state: 'failed', transfer: 250n });
      const file = must(await exportOf({ format: 'xlsx', columns: 'netted,updated' }));
      expect(file.filename).toBe('payouts-2026-11-02.xlsx');
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.chunks) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
      const sheet = book.worksheets[0]!;
      expect(sheet.name).toBe('Payouts');
      expect(sheet.getRow(1).getCell(6).value).toBe('Kept against what you owed');
      expect(sheet.getRow(2).getCell(2).value).toBe('Failed');
      expect(sheet.getRow(2).getCell(3).value).toBe(code === 'AU' ? '2.50' : '250');
      sheet.getRow(2).eachCell((cell) => expect(typeof cell.value).toBe('string'));
    });
  });
});

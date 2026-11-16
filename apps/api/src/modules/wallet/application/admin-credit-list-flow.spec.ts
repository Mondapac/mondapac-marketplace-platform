import ExcelJS from 'exceljs';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ScriptedProbe } from '../../../../test/support/commission-payouts-list-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { MemoryAdminCreditList } from '../../../../test/support/wallet-credit-list-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import {
  CREDIT_ROW_KEYS,
  decimalOf,
  encodeCreditListCursor,
  exportAdminCredits,
  listAdminCreditPage,
  type AdminCreditListDependencies,
  type AdminCreditListPage,
} from './admin-credit-list-flow';
import type { AdminCreditRecord } from './ports/admin-credit.repository';

// The admin Credit requests super list (phase 4, list 24) and its export, on both Market
// fixtures: AU in AUD (two minor digits), ZZ in JPY (none). Nothing here grants, approves or
// rejects credit: the row actions only name what the caller may open.

const FIXTURES = { AU: { currency: 'AUD' }, ZZ: { currency: 'JPY' } } as const;
const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MAKER = id<'Account'>(0xa1);
const CHECKER = id<'Account'>(0xa2);
const CUSTOMER = id<'Account'>(0xc1);
const OTHER_CUSTOMER = id<'Account'>(0xc2);

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

describe.each([['AU'], ['ZZ']] as const)('the admin Credit requests list in market %s', (code) => {
  const { currency } = FIXTURES[code];
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const adminOf = (accountId: Id<'Account'>, m: MarketContext = market): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(accountId === MAKER ? 0x61 : 0x62),
        sellerId: null,
      }),
      'wallet-credit-list',
    );
  const checker = adminOf(CHECKER);

  let rows: Map<string, AdminCreditRecord>;
  let reader: MemoryAdminCreditList;
  let approve: ScriptedProbe;
  let clock: FixedClock;
  let deps: AdminCreditListDependencies;
  let n: number;

  beforeEach(() => {
    rows = new Map();
    reader = new MemoryAdminCreditList((m) =>
      [...rows.entries()].filter(([k]) => k.startsWith(`${m.marketId}:`)).map(([, r]) => r),
    );
    approve = new ScriptedProbe(true);
    clock = new FixedClock(T0.add({ hours: 1 }));
    const [approveKey] = CREDIT_ROW_KEYS;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      list: reader,
      probes: { [approveKey]: approve },
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    };
    n = 0;
  });

  /** A request of the Market, asked `minutes` after T0; pending by default, by the maker. */
  const add = (
    fields: Partial<AdminCreditRecord> & { readonly minutes?: number } = {},
    m: MarketContext = market,
  ): AdminCreditRecord => {
    n += 1;
    const { minutes, ...rest } = fields;
    const at = T0.add({ minutes: minutes ?? n });
    const row: AdminCreditRecord = {
      id: id<'WalletCreditRequest'>(0x1000 + n),
      customerAccountId: CUSTOMER,
      amountMinor: 6000n,
      currency,
      reasonCode: 'goodwill',
      note: null,
      status: 'pending',
      approvalReason: 'issue-cap',
      requestedBy: MAKER,
      requestedAt: at,
      localDay: '2026-11-02',
      expiresAt: at.add({ hours: 72 }),
      idempotencyKey: `key-${n}`,
      fingerprint: `fp-${n}`,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      journalId: null,
      ...rest,
    };
    rows.set(`${m.marketId}:${row.id}`, row);
    return row;
  };
  const granted = (fields: Partial<AdminCreditRecord> & { readonly minutes?: number } = {}) =>
    add({
      status: 'granted',
      approvalReason: null,
      expiresAt: null,
      journalId: id<'WalletJournal'>(0x9000 + n),
      ...fields,
    });

  const list = (input: Record<string, unknown>, context: CallContext = checker) =>
    listAdminCreditPage(deps, context, input);
  const ids = (page: AdminCreditListPage) => page.entries.map((row) => row.id);

  describe('reading', () => {
    it('answers page numbers on the pending view by default, with counts and actions', async () => {
      const a = add({ minutes: 1 });
      const b = add({ minutes: 2 });
      granted({ minutes: 3 });
      add({ minutes: 4, status: 'rejected', decidedBy: CHECKER, decidedAt: T0 });
      add({}, otherMarket);
      const page = must(await list({}));
      expect(ids(page)).toEqual([b.id, a.id]);
      expect(page).toMatchObject({
        counts: { pending: 2, decided: 1, granted: 1, all: 4 },
        total: 2,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      });
      expect(page.entries[0]).toMatchObject({
        id: b.id,
        amount: 6000n,
        currency,
        actions: ['open', 'approve', 'reject'],
      });
      expect(must(await list({ view: 'all' })).total).toBe(4);
      expect(ids(must(await list({ view: 'decided' })))).toHaveLength(1);
    });

    it('offers Approve and Reject only on a pending request of another admin, not expired, to a key holder', async () => {
      const pending = add({ minutes: 1 });
      const expired = add({ minutes: 2, expiresAt: T0 });
      const own = add({ minutes: 3, requestedBy: CHECKER });
      const decided = add({ minutes: 4, status: 'approved', decidedBy: CHECKER, decidedAt: T0 });
      const actionsOf = async () =>
        Object.fromEntries(
          must(await list({ view: 'all' })).entries.map((row) => [row.id, row.actions]),
        );
      expect(await actionsOf()).toEqual({
        [pending.id]: ['open', 'approve', 'reject'],
        [expired.id]: ['open'],
        [own.id]: ['open'],
        [decided.id]: ['open'],
      });
      approve.held = false;
      expect((await actionsOf())[pending.id]).toEqual(['open']);
    });

    it('filters by status, reason, approval reason, ids, requester, dates and amount', async () => {
      const a = add({ minutes: 1, reasonCode: 'promotion', amountMinor: 100n });
      const b = add({
        minutes: 2,
        approvalReason: 'daily-cap',
        customerAccountId: OTHER_CUSTOMER,
        requestedBy: CHECKER,
        amountMinor: 900n,
      });
      const c = add({ minutes: 3, status: 'expired' });
      const all = (input: Record<string, unknown>) => list({ view: 'all', ...input });
      expect(ids(must(await all({ status: 'expired' })))).toEqual([c.id]);
      // A status outside the view is refused.
      expect(await list({ view: 'pending', status: 'expired' })).toMatchObject({ ok: false });
      expect(ids(must(await all({ reason: 'promotion' })))).toEqual([a.id]);
      expect(ids(must(await all({ approvalReason: 'daily-cap' })))).toEqual([b.id]);
      expect(ids(must(await all({ q: a.id.toUpperCase() })))).toEqual([a.id]);
      expect(ids(must(await all({ q: OTHER_CUSTOMER })))).toEqual([b.id]);
      expect(ids(must(await all({ requestedBy: 'me' })))).toEqual([b.id]);
      expect(ids(must(await all({ requestedBy: MAKER })))).toEqual([c.id, a.id]);
      expect(
        ids(
          must(
            await all({
              from: T0.add({ minutes: 2 }).toString(),
              to: T0.add({ minutes: 3 }).toString(),
            }),
          ),
        ),
      ).toEqual([b.id]);
      expect(ids(must(await all({ minAmount: '100', maxAmount: '899' })))).toEqual([a.id]);
      expect(ids(must(await all({ minAmount: '900', maxAmount: '6000' })))).toEqual([c.id, b.id]);
      // Filtered: the total is counted, not read from the view counts.
      expect(must(await all({ reason: 'promotion' })).total).toBe(1);
    });

    it('sorts by requested, amount, expires and decided (none last either way), the id breaking ties', async () => {
      const a = add({ minutes: 1, amountMinor: 300n, expiresAt: T0.add({ hours: 5 }) });
      const b = add({ minutes: 2, amountMinor: 100n, expiresAt: T0.add({ hours: 9 }) });
      const g = granted({ minutes: 3, amountMinor: 200n });
      const d = add({
        minutes: 4,
        status: 'rejected',
        decidedBy: CHECKER,
        decidedAt: T0.add({ hours: 2 }),
        amountMinor: 100n,
      });
      const sorted = async (sort: string, direction: string) =>
        ids(must(await list({ view: 'all', sort, direction })));
      expect(await sorted('requested', 'asc')).toEqual([a.id, b.id, g.id, d.id]);
      // b and d tie on 100: the id breaks the tie, in the direction asked.
      expect(await sorted('amount', 'asc')).toEqual([b.id, d.id, g.id, a.id]);
      expect(await sorted('amount', 'desc')).toEqual([a.id, g.id, d.id, b.id]);
      // g was granted at once: no expiry, last either way.
      expect(await sorted('expires', 'asc')).toEqual([a.id, b.id, d.id, g.id]);
      expect(await sorted('expires', 'desc')).toEqual([d.id, b.id, a.id, g.id]);
      // Only d is decided: first either way, the undecided after it by id.
      expect(await sorted('decided', 'asc')).toEqual([d.id, a.id, b.id, g.id]);
      expect(await sorted('decided', 'desc')).toEqual([d.id, g.id, b.id, a.id]);
    });

    it("pages in both modes and walks the older queue's cursor newest first", async () => {
      const made = [1, 2, 3, 4, 5].map((minutes) => add({ minutes }));
      const second = must(await list({ page: 2, pageSize: 2 }));
      expect(ids(second)).toEqual([made[2]!.id, made[1]!.id]);
      expect(second).toMatchObject({ total: 5, page: 2, pageSize: 2, nextCursor: null });
      const first = must(await list({ status: 'pending', limit: 2 }));
      expect(ids(first)).toEqual([made[4]!.id, made[3]!.id]);
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
      expect(first.nextCursor).toBe(
        encodeCreditListCursor({ requestedAt: made[3]!.requestedAt, id: made[3]!.id }),
      );
      const next = must(await list({ status: 'pending', limit: 2, cursor: first.nextCursor }));
      expect(ids(next)).toEqual([made[2]!.id, made[1]!.id]);
      const last = must(await list({ status: 'pending', limit: 2, cursor: next.nextCursor }));
      expect(ids(last)).toEqual([made[0]!.id]);
      expect(last.nextCursor).toBeNull();
      // Page numbers answer 25 rows by default.
      expect(must(await list({})).pageSize).toBe(25);
    });

    it("walks the older queue's decided and granted tabs with its status, limit and cursor", async () => {
      const decided = [1, 2, 3].map((minutes) =>
        add({
          minutes,
          status: minutes === 2 ? 'expired' : 'rejected',
          decidedBy: minutes === 2 ? null : CHECKER,
          decidedAt: minutes === 2 ? null : T0.add({ hours: 2 }),
        }),
      );
      const grants = [4, 5, 6].map((minutes) => granted({ minutes }));
      add({ minutes: 7 });
      const walk = async (status: string) => {
        const seen: string[] = [];
        let cursor: string | null | undefined;
        do {
          const page = must(await list({ status, limit: 2, ...(cursor ? { cursor } : {}) }));
          expect(page.entries.every((row) => row.actions.join() === 'open')).toBe(true);
          seen.push(...ids(page));
          cursor = page.nextCursor;
        } while (cursor !== null);
        return seen;
      };
      expect(await walk('decided')).toEqual(decided.map((r) => r.id).reverse());
      expect(await walk('granted')).toEqual(grants.map((r) => r.id).reverse());
      // A status the view does not show is refused, not answered empty.
      expect(await list({ status: 'approved' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'status', code: 'outside-view' }] },
      });
      expect(ids(must(await list({ view: 'decided', status: 'expired' })))).toEqual([
        decided[1]!.id,
      ]);
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      add({});
      expect(
        await list({
          view: 'mine',
          reason: 'x',
          approvalReason: 'x',
          q: 'not-an-id',
          requestedBy: 'you',
          from: 'yesterday',
          minAmount: '-1',
          sort: 'customer',
          direction: 'up',
          page: 0,
          pageSize: 101,
        }),
      ).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'view', code: 'value' },
            { path: 'reason', code: 'value' },
            { path: 'approvalReason', code: 'value' },
            { path: 'q', code: 'format' },
            { path: 'requestedBy', code: 'format' },
            { path: 'from', code: 'format' },
            { path: 'minAmount', code: 'format' },
            { path: 'page', code: 'range' },
            { path: 'pageSize', code: 'range' },
            { path: 'sort', code: 'value' },
            { path: 'direction', code: 'value' },
          ],
        },
      });
      expect(await list({ limit: 5, page: 2, sort: 'amount' })).toMatchObject({
        ok: false,
        error: {
          fields: [
            { path: 'page', code: 'with-cursor' },
            { path: 'sort', code: 'with-cursor' },
          ],
        },
      });
      expect(
        await list({ from: T0.toString(), to: T0.toString(), minAmount: '9', maxAmount: '1' }),
      ).toMatchObject({
        ok: false,
        error: {
          fields: [
            { path: 'to', code: 'range' },
            { path: 'maxAmount', code: 'range' },
          ],
        },
      });
      expect(await list({ page: 500, pageSize: 100 })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'page', code: 'too-deep' }] },
      });
      expect(reader.reads).toBe(0);
    });

    it('is for signed-in admins of the Market only, never in an acting-as session', async () => {
      add({});
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: id<'Account'>(0xb1),
          sessionId: id<'Session'>(0x63),
          sellerId: id<'Seller'>(0x51),
        }),
        'wallet-credit-list',
      );
      expect(await list({}, seller)).toEqual({ ok: false, error: { code: 'access.denied' } });
      const actingAs = {
        ...checker,
        actor: { ...checker.actor, actingAs: { adminAccountId: CHECKER } },
      } as unknown as CallContext;
      expect(await list({}, actingAs)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await exportAdminCredits(deps, actingAs, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(reader.reads).toBe(0);
      expect(must(await list({}, adminOf(CHECKER, otherMarket))).entries).toEqual([]);
    });
  });

  describe('the export', () => {
    const exportOf = (input: Record<string, unknown>, context: CallContext = checker) =>
      exportAdminCredits(deps, context, input);

    it("writes what the list shows in the panel's words, extra columns in the order asked", async () => {
      const a = add({ minutes: 1, amountMinor: 12345n, note: 'parcel lost' });
      const b = add({
        minutes: 2,
        status: 'rejected',
        reasonCode: 'service-recovery',
        decidedBy: CHECKER,
        decidedAt: T0.add({ minutes: 30 }),
        decisionReason: 'amount-too-high',
      });
      add({}, otherMarket);
      const file = must(
        await exportOf({ view: 'all', columns: 'decision-reason,note,approval-reason' }),
      );
      expect(file).toMatchObject({
        filename: 'credit-requests-2026-11-02.csv',
        contentType: 'text/csv; charset=utf-8',
      });
      const lines = await linesOf(file);
      expect(lines[0]).toBe(
        '﻿Request ID,Customer ID,Amount,Currency,Reason,Status,Requested by,Requested (UTC),Decision reason,Note,Why it needed approval',
      );
      expect(lines.slice(1)).toEqual([
        `${b.id},${CUSTOMER},${decimalOf(6000n, currency)},${currency},Service recovery,Rejected,${MAKER},${b.requestedAt.toString()},Amount too high,,Over the per-issue limit`,
        `${a.id},${CUSTOMER},${currency === 'AUD' ? '123.45' : '12345'},${currency},Goodwill,Pending,${MAKER},${a.requestedAt.toString()},,parcel lost,Over the per-issue limit`,
      ]);
      // The default view is pending, as on the page.
      expect(await linesOf(must(await exportOf({})))).toHaveLength(2);
      expect(
        (await linesOf(must(await exportOf({ view: 'all', sort: 'requested', direction: 'asc' }))))
          .slice(1)
          .map((line) => line.split(',')[0]),
      ).toEqual([a.id, b.id]);
    });

    it('writes the chosen rows in the order given; a request of another Market refuses the file', async () => {
      const a = add({ minutes: 1 });
      const b = add({ minutes: 2 });
      const foreign = add({}, otherMarket);
      const lines = await linesOf(must(await exportOf({ ids: `${a.id},${b.id}` })));
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([a.id, b.id]);
      expect(await exportOf({ ids: `${a.id},${foreign.id}` })).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-not-found' },
      });
    });

    it('refuses more than 10,000 rows, an unknown key, a bad column and a seller', async () => {
      for (let i = 0; i < 3; i += 1) add({ minutes: i + 1 });
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
      expect(await exportOf({ cursor: 'x' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'cursor', code: 'unknown' }] },
      });
      expect(await exportOf({ columns: 'fingerprint' })).toMatchObject({ ok: false });
      // More than 200 chosen ids, or one twice, refuses the file before any read.
      const reads = reader.reads;
      const chosen = Array.from({ length: 201 }, (_, i) => id<'WalletCreditRequest'>(0x5000 + i));
      expect(await exportOf({ ids: chosen.join(',') })).toMatchObject({
        ok: false,
        error: { code: 'batch.too-large', max: 200 },
      });
      expect(await exportOf({ ids: `${chosen[0]},${chosen[0]}` })).toMatchObject({ ok: false });
      expect(reader.reads).toBe(reads);
      expect(await exportOf({ format: 'pdf' })).toMatchObject({ ok: false });
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: id<'Account'>(0xb1),
          sessionId: id<'Session'>(0x63),
          sellerId: id<'Seller'>(0x51),
        }),
        'wallet-credit-list',
      );
      expect(await exportOf({}, seller)).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('guards a formula-like note in CSV and writes every XLSX cell as a string', async () => {
      add({ minutes: 1, note: '=HYPERLINK("http://x","y")' });
      const csv = await linesOf(must(await exportOf({ columns: 'note' })));
      expect(csv[1]!.endsWith(`,"'=HYPERLINK(""http://x"",""y"")"`)).toBe(true);
      const xlsx = must(await exportOf({ format: 'xlsx', columns: 'note' }));
      expect(xlsx.filename).toBe('credit-requests-2026-11-02.xlsx');
      const parts: Buffer[] = [];
      for await (const chunk of xlsx.chunks) {
        parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
      const sheet = book.getWorksheet('Credit requests')!;
      const values: unknown[] = [];
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          values.push(cell.value);
        }),
      );
      expect(values.every((value) => typeof value === 'string')).toBe(true);
      expect(values).toContain('=HYPERLINK("http://x","y")');
    });
  });
});

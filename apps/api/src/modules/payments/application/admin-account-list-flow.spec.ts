import ExcelJS from 'exceljs';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeAccountSellerNames,
  MemoryAccountList,
} from '../../../../test/support/payments-account-list-fakes';
import { MemoryAccountStore } from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import {
  exportAccounts,
  listAccountPage,
  type AccountListPage,
  type AdminAccountListDependencies,
} from './admin-account-list-flow';
import type { ConnectedAccountRecord } from './ports/connected-account-store';

// The admin Seller accounts super list (phase 4, list 22) and its export, on both Market
// fixtures. Read only: no Stripe id, account hash or bank detail is answered or written.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const NOW = T0.add({ hours: 240 });
const id = (n: number): string => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

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

describe.each([['AU'], ['ZZ']] as const)('the admin Seller accounts list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const actorOf = (m: MarketContext, population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population,
        accountId: id(population === 'admin' ? 0xad : 0xa1) as Id<'Account'>,
        sessionId: id(0x61) as Id<'Session'>,
        sellerId: population === 'seller' ? (id(0x51) as Id<'Seller'>) : null,
      }),
      `pay-${population}-accounts`,
    );
  const admin = actorOf(market, 'admin');

  let store: MemoryAccountStore;
  let reader: MemoryAccountList;
  let names: FakeAccountSellerNames;
  let deps: AdminAccountListDependencies;
  let n: number;

  beforeEach(() => {
    store = new MemoryAccountStore();
    reader = new MemoryAccountList(store);
    names = new FakeAccountSellerNames();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      list: reader,
      sellerNames: names,
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(NOW),
    };
    n = 0;
  });

  /** An account of the Market, created `minutes` after T0. */
  const add = (
    fields: Partial<ConnectedAccountRecord> & { readonly minutes?: number; readonly name?: string },
    m: MarketContext = market,
  ): ConnectedAccountRecord => {
    n += 1;
    const { minutes, name, ...rest } = fields;
    const row: ConnectedAccountRecord = {
      sellerId: id(0x1000 + n),
      accountRef: `acct_${n}`,
      status: 'enabled',
      detailsSubmitted: true,
      transfersActive: true,
      payoutsEnabled: true,
      requirementsDue: 0,
      requirementsPastDue: false,
      lastReadAt: null,
      createdAt: T0.add({ minutes: minutes ?? n }),
      coolingOffUntil: null,
      payoutsPausedUntil: null,
      payoutScheduleApplied: null,
      payoutScheduleRevision: 0,
      lastChangeId: null,
      externalAccountHmac: 'hmac-sha256:k1:secret',
      ...rest,
    };
    store.rows.set(`${m.marketId}/${row.sellerId}`, { ...row, market: m.marketId });
    if (name !== undefined) names.names.set(row.sellerId, name);
    return row;
  };
  const list = (input: Record<string, unknown>, context: CallContext = admin) =>
    listAccountPage(deps, context, input);
  const ids = (page: AccountListPage) => page.items.map((row) => row.sellerId);

  describe('reading', () => {
    it('answers page numbers by default: newest first, 25 a page, counts per status, store names', async () => {
      const made = (['not-started', 'pending', 'enabled', 'restricted', 'rejected'] as const).map(
        (status) => add({ status, name: `Store ${status}` }),
      );
      add({}, otherMarket);
      const page = must(await list({}));
      expect(ids(page)).toEqual(made.map((row) => row.sellerId).reverse());
      expect(page).toMatchObject({
        total: 5,
        page: 1,
        pageSize: 25,
        paging: 'pages',
        hasNext: false,
        nextCursor: null,
      });
      expect(page.counts).toEqual({
        all: 5,
        'not-started': 1,
        pending: 1,
        enabled: 1,
        restricted: 1,
        rejected: 1,
      });
      expect(page.items[0]).toMatchObject({
        sellerName: 'Store rejected',
        actions: ['open'],
      });
      const answer = JSON.stringify(page);
      expect(answer).not.toContain('acct_');
      expect(answer).not.toContain('hmac');
    });

    it('filters by status, readiness, details due, the waiting period, seller and created time', async () => {
      const ready = add({ name: 'Halal Corner' });
      const waiting = add({ coolingOffUntil: NOW.add({ hours: 1 }), name: 'Spice Lane' });
      const waited = add({ coolingOffUntil: NOW.subtract({ hours: 1 }) });
      const paused = add({ status: 'restricted', payoutsPausedUntil: NOW.add({ hours: 5 }) });
      const late = add({ status: 'pending', requirementsDue: 3, requirementsPastDue: true });
      const due = add({ status: 'pending', requirementsDue: 2 });
      const of = async (input: Record<string, unknown>) => ids(must(await list(input)));
      const newest = (...rows: ConnectedAccountRecord[]) =>
        rows.map((row) => row.sellerId).reverse();
      expect(await of({ status: 'pending' })).toEqual(newest(late, due));
      expect(await of({ ready: 'yes' })).toEqual(newest(ready, waited));
      expect(await of({ ready: 'no' })).toEqual(newest(waiting, paused, late, due));
      expect(await of({ requirements: 'past-due' })).toEqual(newest(late));
      expect(await of({ requirements: 'due' })).toEqual(newest(late, due));
      expect(await of({ requirements: 'none' })).toEqual(newest(ready, waiting, waited, paused));
      expect(await of({ waiting: 'cooling-off' })).toEqual(newest(waiting));
      expect(await of({ waiting: 'paused' })).toEqual(newest(paused));
      expect(await of({ q: ready.sellerId.toUpperCase() })).toEqual([ready.sellerId]);
      expect(await of({ q: 'lane' })).toEqual([waiting.sellerId]);
      expect(await of({ from: T0.add({ minutes: 5 }).toString() })).toEqual(newest(late, due));
      expect(await of({ to: T0.add({ minutes: 2 }).toString() })).toEqual(newest(ready));
      // The tabs count the same search and filters, whatever the status.
      expect(must(await list({ status: 'enabled', requirements: 'due' })).counts).toMatchObject({
        all: 2,
        pending: 2,
        enabled: 0,
      });
    });

    it('sorts by created, last check and details due with the seller id breaking ties', async () => {
      const tied = [0, 1, 2].map(() => add({ minutes: 5, lastReadAt: T0 }));
      const asc = tied.map((row) => row.sellerId);
      for (const sort of ['created', 'last-read', 'requirements']) {
        expect(ids(must(await list({ sort, direction: 'asc' })))).toEqual(asc);
        expect(ids(must(await list({ sort, direction: 'desc' })))).toEqual([...asc].reverse());
      }
      const never = add({ minutes: 1, lastReadAt: null });
      const late = add({ minutes: 2, requirementsDue: 1, requirementsPastDue: true });
      expect(ids(must(await list({ sort: 'last-read', direction: 'desc' }))).at(-1)).toBe(
        never.sellerId,
      );
      expect(ids(must(await list({ sort: 'last-read', direction: 'asc' })))[0]).toBe(
        never.sellerId,
      );
      expect(ids(must(await list({ sort: 'requirements', direction: 'desc' })))[0]).toBe(
        late.sellerId,
      );
    });

    it('pages in both modes and walks the older card cursor newest first', async () => {
      const made = Array.from({ length: 27 }, () => add({ minutes: 1 }));
      const newest = made.map((row) => row.sellerId).reverse();
      const first = must(await list({}));
      expect(ids(first)).toEqual(newest.slice(0, 25));
      expect(first.hasNext).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const more = must(await list({ cursor: first.nextCursor }));
      expect(ids(more)).toEqual(newest.slice(25));
      expect(more).toMatchObject({ paging: 'prev-next', counts: null, nextCursor: null });
      const second = must(await list({ page: 2, pageSize: 10 }));
      expect(ids(second)).toEqual(newest.slice(10, 20));
      const prevNext = must(await list({ paging: 'prev-next', page: 3, pageSize: 10 }));
      expect(ids(prevNext)).toEqual(newest.slice(20));
      expect(prevNext).toMatchObject({ total: null, counts: null, hasNext: false });
      // Another order gives no cursor: the older card's walk is newest first only.
      expect(must(await list({ sort: 'last-read' })).nextCursor).toBeNull();
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      const refused = await list({
        status: 'open',
        ready: 'maybe',
        q: 'x',
        sort: 'name',
        stripe: 'acct_1',
        cursor: 'nope',
        page: 2,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      const paths =
        'fields' in refused.error ? refused.error.fields.map((field) => field.path).sort() : [];
      expect(paths).toEqual(['cursor', 'page', 'q', 'ready', 'sort', 'status', 'stripe']);
      expect(await list({ page: 500, pageSize: 100 })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'page', code: 'too-deep' }] },
      });
      expect(reader.reads).toBe(0);
    });

    it('fails closed when the store search fails, and degrades names to null', async () => {
      add({ name: 'Halal Corner' });
      names.failing = true;
      expect(await list({ q: 'corner' })).toEqual({
        ok: false,
        error: { code: 'payments.search-unavailable' },
      });
      expect(must(await list({})).items[0]!.sellerName).toBeNull();
    });

    it('is for admins only', async () => {
      add({});
      expect(await list({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(reader.reads).toBe(0);
    });
  });

  describe('the export', () => {
    const exportOf = (input: Record<string, unknown>, context: CallContext = admin) =>
      exportAccounts(deps, context, input);

    it("writes what the list shows in the panel's words, extra columns in the order asked", async () => {
      const ready = add({ name: 'Halal Corner', lastReadAt: T0, minutes: 1 });
      const late = add({
        status: 'pending',
        requirementsDue: 2,
        requirementsPastDue: true,
        coolingOffUntil: NOW.add({ hours: 3 }),
        minutes: 2,
      });
      add({}, otherMarket);
      const file = must(await exportOf({ columns: 'last-read,cooling-off,seller-id' }));
      expect(file).toMatchObject({
        filename: 'seller-accounts-2026-11-12.csv',
        contentType: 'text/csv; charset=utf-8',
      });
      const lines = await linesOf(file);
      expect(lines[0]).toBe(
        '﻿Seller,Status,Ready,Details due,Past due,Created,Last checked (UTC),Waiting until (UTC),Seller ID',
      );
      expect(lines.slice(1)).toEqual([
        `Seller ${late.sellerId},Pending,No,2,Yes,${late.createdAt.toString()},,${NOW.add({ hours: 3 }).toString()},${late.sellerId}`,
        `Halal Corner,Enabled,Yes,0,No,${ready.createdAt.toString()},${T0.toString()},,${ready.sellerId}`,
      ]);
      const text = lines.join('\n');
      expect(text).not.toContain('acct_');
      expect(text).not.toContain('hmac');
      expect(await linesOf(must(await exportOf({ status: 'pending' })))).toHaveLength(2);
      expect(
        (await linesOf(must(await exportOf({ sort: 'created', direction: 'asc' }))))
          .slice(1)
          .map((line) => line.split(',')[0]),
      ).toEqual(['Halal Corner', `Seller ${late.sellerId}`]);
    });

    it('writes the chosen rows in the order given; a seller of another Market refuses the file', async () => {
      const a = add({});
      const b = add({});
      const elsewhere = add({}, otherMarket);
      const lines = await linesOf(
        must(await exportOf({ ids: `${b.sellerId},${a.sellerId}`, columns: 'seller-id' })),
      );
      expect(lines.slice(1).map((line) => line.split(',').at(-1))).toEqual([
        b.sellerId,
        a.sellerId,
      ]);
      expect(await exportOf({ ids: `${a.sellerId},${elsewhere.sellerId}` })).toEqual({
        ok: false,
        error: { code: 'payments.connected-account.not-found' },
      });
    });

    it('refuses more than 10,000 rows, a capped store search, an unknown key and a seller', async () => {
      reader.ids = () => Promise.resolve(Array.from({ length: 10_001 }, (_, i) => id(0x9000 + i)));
      reader.count = () => Promise.resolve(12_000);
      expect(await exportOf({})).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 12_000 },
      });
      names.capped = true;
      expect(await exportOf({ q: 'corner' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] },
      });
      expect(await exportOf({ page: '2' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(await exportOf({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('writes an XLSX file where every cell is a string', async () => {
      add({ status: 'restricted', name: 'Spice Lane' });
      const file = must(await exportOf({ format: 'xlsx', columns: 'paused' }));
      expect(file.filename).toBe('seller-accounts-2026-11-12.xlsx');
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.chunks) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
      const sheet = book.worksheets[0]!;
      expect(sheet.name).toBe('Seller accounts');
      expect(sheet.getRow(1).getCell(7).value).toBe('Payouts paused');
      expect(sheet.getRow(2).getCell(1).value).toBe('Spice Lane');
      expect(sheet.getRow(2).getCell(2).value).toBe('Restricted');
      sheet.getRow(2).eachCell((cell) => expect(typeof cell.value).toBe('string'));
    });
  });
});

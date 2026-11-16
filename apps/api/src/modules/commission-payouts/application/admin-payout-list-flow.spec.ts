import ExcelJS from 'exceljs';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryHolds } from '../../../../test/support/commission-payouts-fakes';
import {
  FakeStoreSearch,
  MemoryAdminPayoutList,
  ScriptedProbe,
} from '../../../../test/support/commission-payouts-list-fakes';
import { MemoryPayouts } from '../../../../test/support/commission-payouts-payout-fakes';
import { FakeSellerNames } from '../../../../test/support/commission-payouts-dispute-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { Payout, PayoutState } from '../domain/payout';
import type { PayoutHoldRecord } from './ports/payout-hold.repository';
import {
  decimalOf,
  exportAdminPayouts,
  listAdminPayouts,
  PAYOUT_ROW_KEYS,
  type AdminPayoutListDependencies,
  type AdminPayoutListPage,
} from './admin-payout-list-flow';

// The admin Payouts super list (phase 4, list 21) and its export, on both Market fixtures: AU in
// AUD (two minor digits), ZZ in JPY (none). Nothing here moves money.

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

describe.each([['AU'], ['ZZ']] as const)('the admin Payouts list in market %s', (code) => {
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
      `cp-${population}-list`,
    );
  const admin = actorOf(market, 'admin');

  let payouts: MemoryPayouts;
  let holds: MemoryHolds;
  let reader: MemoryAdminPayoutList;
  let names: FakeSellerNames;
  let search: FakeStoreSearch;
  let probes: { approve: ScriptedProbe; place: ScriptedProbe; release: ScriptedProbe };
  let deps: AdminPayoutListDependencies;
  let n: number;

  beforeEach(() => {
    payouts = new MemoryPayouts();
    holds = new MemoryHolds();
    reader = new MemoryAdminPayoutList(payouts, holds);
    names = new FakeSellerNames();
    names.names.set(SELLER_A, 'Halal Corner');
    names.names.set(SELLER_B, 'Spice Lane');
    search = new FakeStoreSearch(names.names);
    probes = {
      approve: new ScriptedProbe(true),
      place: new ScriptedProbe(true),
      release: new ScriptedProbe(true),
    };
    const [approveKey, placeKey, releaseKey] = PAYOUT_ROW_KEYS;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      payouts: reader,
      sellerNames: names,
      storeSearch: search,
      probes: {
        [approveKey]: probes.approve,
        [placeKey]: probes.place,
        [releaseKey]: probes.release,
      },
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
    const payout: Payout = {
      id: id<'Payout'>(0x1000 + n),
      sellerId: SELLER_A,
      currency,
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
      ...fields,
    };
    payouts.rows.set(`${m.marketId}:${payout.id}`, payout);
    return payout;
  };
  const hold = (fields: Partial<PayoutHoldRecord>): PayoutHoldRecord => {
    n += 1;
    const record: PayoutHoldRecord = {
      id: id<'PayoutHold'>(0x2000 + n),
      sellerId: SELLER_A,
      sellerOrderId: null,
      reason: 'admin-review',
      origin: 'admin',
      sourceRef: id<'PayoutHold'>(0x2000 + n),
      placedBy: ADMIN,
      placedAt: T0.add({ minutes: n }),
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      ...fields,
    };
    holds.rows.set(`${market.marketId}:${record.id}`, record);
    return record;
  };
  const list = (input: Record<string, unknown>, context: CallContext = admin) =>
    listAdminPayouts(deps, context, input);
  const ids = (page: AdminPayoutListPage) => page.payouts.map((row) => row.payoutId);

  describe('reading', () => {
    it('answers page numbers by default: newest first, 25 a page, the total and every view count', async () => {
      const states: PayoutState[] = [
        'awaiting-approval',
        'approved',
        'instructing',
        'instructed',
        'paid',
        'failed',
        'not-sent',
        'voided',
        'settled-by-netting',
        'pending',
      ];
      const made = states.map((state) => add({ state }));
      add({ state: 'paid' }, otherMarket);

      const page = must(await list({}));
      expect(ids(page)).toEqual(made.map((p) => p.id).reverse());
      expect(page).toMatchObject({ total: 10, page: 1, pageSize: 25, nextCursor: null });
      expect(page.counts).toEqual({
        all: 10,
        'awaiting-approval': 1,
        sending: 3,
        paid: 1,
        failed: 1,
        'not-sent': 1,
      });
      expect(page.payouts[0]).toMatchObject({
        storeName: 'Halal Corner',
        transfer: { amountMinor: 10000n, currency },
      });
    });

    it('shows a view, narrows it to one state, and matches nothing for a state outside it', async () => {
      add({ state: 'approved' });
      const instructing = add({ state: 'instructing' });
      add({ state: 'paid' });
      expect(must(await list({ view: 'sending' })).total).toBe(2);
      expect(ids(must(await list({ view: 'sending', status: 'INSTRUCTING' })))).toEqual([
        instructing.id,
      ]);
      expect(must(await list({ view: 'sending', status: 'paid' })).payouts).toEqual([]);
    });

    it('filters by payout id, seller, approval mode, creation time and transfer amount', async () => {
      const a = add({ approvalMode: 'MANUAL', transfer: 5000n, minutes: 10 });
      const b = add({ sellerId: SELLER_B, transfer: 20000n, minutes: 20 });
      add({ transfer: 90000n, minutes: 30 });
      expect(ids(must(await list({ q: a.id.toUpperCase() })))).toEqual([a.id]);
      expect(ids(must(await list({ sellerId: SELLER_B })))).toEqual([b.id]);
      expect(ids(must(await list({ approvalMode: 'MANUAL' })))).toEqual([a.id]);
      expect(
        ids(
          must(
            await list({
              from: T0.add({ minutes: 10 }).toString(),
              to: T0.add({ minutes: 30 }).toString(),
            }),
          ),
        ),
      ).toEqual([b.id, a.id]);
      expect(ids(must(await list({ minAmount: '5000', maxAmount: '20000' })))).toEqual([
        b.id,
        a.id,
      ]);
      // A narrower filter is counted, not read from the view counts.
      expect(must(await list({ minAmount: '20000' })).total).toBe(2);
    });

    it('sorts by amount, state change and slot, with the id breaking ties', async () => {
      const low = add({ transfer: 100n, stateChangedAt: T0.add({ hours: 5 }) });
      const tieA = add({ transfer: 500n });
      const tieB = add({ transfer: 500n });
      expect(ids(must(await list({ sort: 'amount', direction: 'asc' })))).toEqual([
        low.id,
        tieA.id,
        tieB.id,
      ]);
      expect(ids(must(await list({ sort: 'state-changed' })))[0]).toBe(low.id);
      expect(ids(must(await list({ sort: 'slot', direction: 'asc' })))).toEqual([
        low.id,
        tieA.id,
        tieB.id,
      ]);
    });

    it('breaks every sort tie by the id, in both directions', async () => {
      const at = T0.add({ hours: 3 });
      const tied = [0, 1, 2].map(() =>
        add({ transfer: 500n, slotAt: at, stateChangedAt: at, minutes: 7 }),
      );
      const asc = tied.map((p) => p.id);
      for (const sort of ['created', 'amount', 'state-changed', 'slot']) {
        expect(ids(must(await list({ sort, direction: 'asc' })))).toEqual(asc);
        expect(ids(must(await list({ sort, direction: 'desc' })))).toEqual([...asc].reverse());
      }
    });

    it('keeps Previous and Next to limit and cursor, and refuses a page size, direction, limit or cursor it cannot use', async () => {
      expect(await list({ limit: 2, pageSize: 10, direction: 'asc' })).toMatchObject({
        error: {
          fields: [
            { path: 'pageSize', code: 'with-cursor' },
            { path: 'direction', code: 'with-cursor' },
          ],
        },
      });
      for (const limit of [0, 101, -1]) {
        expect(await list({ limit })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
        });
      }
      expect(await list({ cursor: 'not-a-cursor' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'cursor', code: 'format' }] },
      });
      expect(reader.reads).toBe(0);
    });

    it('walks Previous and Next inside one state, as the old panel asks', async () => {
      const waiting = [1, 2, 3].map((minutes) => add({ state: 'awaiting-approval', minutes }));
      add({ state: 'paid', minutes: 4 });
      const first = must(await list({ status: 'awaiting-approval', limit: 2 }));
      const second = must(
        await list({ status: 'awaiting-approval', limit: 2, cursor: first.nextCursor }),
      );
      expect(second.nextCursor).toBeNull();
      expect([...ids(first), ...ids(second)]).toEqual(waiting.map((p) => p.id).reverse());
    });

    it('answers a status without limit or cursor with page numbers: Previous/Next needs one of them', async () => {
      for (let i = 0; i < 30; i += 1) add({ state: 'failed' });
      expect(must(await list({ status: 'failed' }))).toMatchObject({
        total: 30,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      });
      const prevNext = must(await list({ status: 'failed', limit: 50 }));
      expect(prevNext).toMatchObject({ total: null, page: null, pageSize: 50, nextCursor: null });
      expect(prevNext.payouts).toHaveLength(30);
    });

    it('walks Previous and Next newest first through payouts created at the same instant', async () => {
      const same = [0, 1, 2, 3, 4].map(() => add({ minutes: 1 }));
      const first = must(await list({ limit: 2 }));
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
      const second = must(await list({ limit: 2, cursor: first.nextCursor }));
      const third = must(await list({ limit: 2, cursor: second.nextCursor }));
      expect(third.nextCursor).toBeNull();
      expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(
        same.map((p) => p.id).reverse(),
      );
    });

    it('pages by number and stops at row 10,000', async () => {
      for (let i = 0; i < 3; i += 1) add({});
      const page = must(await list({ page: 2, pageSize: 2 }));
      expect(page.payouts).toHaveLength(1);
      expect(page).toMatchObject({ total: 3, page: 2 });
      expect(await list({ page: 101, pageSize: 100 })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'too-deep' }] },
      });
    });

    it('refuses what it does not know, every field at once, and reads nothing', async () => {
      const answer = await list({
        view: 'archived',
        status: 'lost',
        q: 'not-an-id',
        sellerId: 'x',
        approvalMode: 'auto',
        from: '2026-11-03',
        minAmount: '-1',
        search: 'a',
        sort: 'store',
        direction: 'up',
        pageSize: 101,
      });
      expect(answer).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: expect.arrayContaining([
            { path: 'view', code: 'value' },
            { path: 'status', code: 'value' },
            { path: 'approvalMode', code: 'value' },
            { path: 'q', code: 'format' },
            { path: 'sellerId', code: 'format' },
            { path: 'search', code: 'length' },
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
      expect(
        await list({ from: T0.toString(), to: T0.toString(), minAmount: '9', maxAmount: '1' }),
      ).toMatchObject({
        error: {
          fields: [
            { path: 'to', code: 'range' },
            { path: 'maxAmount', code: 'range' },
          ],
        },
      });
      expect(reader.reads).toBe(0);
    });

    it('is for admins only', async () => {
      add({});
      expect(await list({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(reader.reads).toBe(0);
    });

    it('shows a payout whose store name cannot be read, with no name', async () => {
      add({});
      names.unavailable = true;
      expect(must(await list({})).payouts[0]!.storeName).toBeNull();
    });
  });

  describe('the store search', () => {
    it('matches the payouts of the stores whose name holds the term', async () => {
      add({ sellerId: SELLER_A });
      const b = add({ sellerId: SELLER_B });
      const page = must(await list({ search: '  spice ' }));
      expect(ids(page)).toEqual([b.id]);
      expect(search.terms).toEqual(['spice']);
      expect(must(await list({ search: 'nothing like it' })).payouts).toEqual([]);
    });

    it('fails closed when sellers cannot answer, before any read', async () => {
      add({});
      search.failing = true;
      expect(await list({ search: 'spice' })).toEqual({
        ok: false,
        error: { code: 'commission-payouts.search-unavailable' },
      });
      expect(reader.reads).toBe(0);
    });

    it('says when the store search was capped', async () => {
      search.capped = true;
      expect(must(await list({ search: 'spice' })).searchCapped).toBe(true);
    });
  });

  describe('the row actions', () => {
    const actionsOf = async () =>
      Object.fromEntries(
        must(await list({})).payouts.map((row) => [row.state, row.actions] as const),
      );

    it('offers Approve on a payout that waits, and a hold on one that has not gone to payments', async () => {
      for (const state of ['awaiting-approval', 'approved', 'instructing', 'paid'] as const) {
        add({ state, sellerId: id<'Seller'>(0x70 + n) });
      }
      expect(await actionsOf()).toEqual({
        'awaiting-approval': ['open', 'approve', 'place-hold'],
        approved: ['open', 'place-hold'],
        instructing: ['open'],
        paid: ['open'],
      });
    });

    it("offers Release of the seller's newest active admin hold instead of a second hold", async () => {
      add({ state: 'awaiting-approval' });
      hold({ placedAt: T0 });
      const newest = hold({ placedAt: T0.add({ hours: 1 }) });
      hold({ releasedAt: T0.add({ hours: 2 }), placedAt: T0.add({ hours: 2 }) });
      const row = must(await list({})).payouts[0]!;
      expect(row.actions).toEqual(['open', 'approve', 'release-hold']);
      expect(row.activeHoldId).toBe(newest.id);
    });

    it('offers no Release on a payout the hold no longer stops', async () => {
      add({ state: 'paid' });
      hold({});
      expect(must(await list({})).payouts[0]!.actions).toEqual(['open']);
    });

    it('names the hold only to a caller who may release it', async () => {
      add({ state: 'approved' });
      hold({});
      probes.release.held = false;
      expect(must(await list({})).payouts[0]).toMatchObject({
        activeHoldId: null,
        actions: ['open'],
      });
    });

    it('ignores system holds and holds on one seller order', async () => {
      add({ state: 'approved' });
      hold({ origin: 'system', reason: 'seller-suspended', placedBy: null });
      hold({ sellerOrderId: id<'SellerOrder'>(0x301) });
      const row = must(await list({})).payouts[0]!;
      expect(row).toMatchObject({ activeHoldId: null, actions: ['open', 'place-hold'] });
    });

    it('offers only what the caller holds the key for; a failing probe offers nothing', async () => {
      add({ state: 'awaiting-approval' });
      hold({});
      probes.approve.held = false;
      probes.release.execute = () => Promise.reject(new Error('down'));
      expect(must(await list({})).payouts[0]!.actions).toEqual(['open']);
    });
  });

  describe('the export', () => {
    const exportOf = (input: Record<string, unknown>, context: CallContext = admin) =>
      exportAdminPayouts(deps, context, input);

    it('writes the payouts the list shows, amounts as decimals of the currency', async () => {
      const a = add({ transfer: 12345n, gross: 12345n, minutes: 1 });
      const b = add({
        sellerId: SELLER_B,
        state: 'failed',
        outcomeCode: 'card_declined',
        minutes: 2,
      });
      const file = must(await exportOf({ columns: 'gross,outcome' }));
      expect(file.filename).toBe('payouts-2026-11-02.csv');
      const lines = (await text(file))
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe('Payout ID,Store,Status,Transfer,Currency,Created,Gross,Outcome');
      const [hundred, other] = code === 'AU' ? ['100.00', '123.45'] : ['10000', '12345'];
      expect(lines[1]).toBe(
        `${b.id},Spice Lane,Failed,${hundred},${currency},${b.createdAt.toString()},${hundred},card_declined`,
      );
      expect(lines[2]).toContain(`${a.id},Halal Corner,Paid,${other}`);
      expect(lines).toHaveLength(3);
    });

    it('writes the chosen rows only, in the order given, and refuses an id of another Market', async () => {
      const a = add({});
      const b = add({});
      const other = add({}, otherMarket);
      const lines = (await text(must(await exportOf({ ids: `${a.id},${b.id}` }))))
        .trim()
        .split('\r\n');
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([a.id, b.id]);
      expect(await exportOf({ ids: `${a.id},${other.id}` })).toEqual({
        ok: false,
        error: { code: 'commission-payouts.payout-not-found' },
      });
    });

    it('uses the selector of the list and refuses a key it does not know', async () => {
      add({ state: 'paid' });
      const failed = add({ state: 'failed' });
      const lines = (await text(must(await exportOf({ view: 'failed' })))).trim().split('\r\n');
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([failed.id]);
      expect(await exportOf({ page: '2' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(await exportOf({ format: 'pdf' })).toMatchObject({ ok: false });
      expect(await exportOf({ columns: 'iban' })).toMatchObject({ ok: false });
    });

    it('refuses more than 10,000 payouts whole, with the total', async () => {
      reader.idsPage = () =>
        Promise.resolve(Array.from({ length: 10_001 }, (_, i) => id<'Payout'>(0x9000 + i)));
      reader.count = () => Promise.resolve(12_000);
      expect(await exportOf({})).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 12_000 },
      });
    });

    it("writes the extra columns in the order asked, and every state in the panel's words", async () => {
      const words: Record<Payout['state'], string> = {
        pending: 'Planned',
        'awaiting-approval': 'Awaiting approval',
        approved: 'Approved',
        instructing: 'Sending',
        instructed: 'Sent',
        paid: 'Paid',
        failed: 'Failed',
        'not-sent': 'Not sent',
        voided: 'Cancelled',
        'settled-by-netting': 'Settled against debt',
      };
      const made = Object.keys(words).map((state, i) =>
        add({ state: state as Payout['state'], minutes: 100 - i }),
      );
      const lines = (await text(must(await exportOf({ columns: 'seller-id,gross' }))))
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe('Payout ID,Store,Status,Transfer,Currency,Created,Seller ID,Gross');
      expect(lines.slice(1).map((line) => line.split(',')[2])).toEqual(Object.values(words));
      expect(lines[1]!.split(',').slice(6)).toEqual([SELLER_A, code === 'AU' ? '100.00' : '10000']);
      expect(made).toHaveLength(10);
    });

    it('names a store it cannot read by its seller id', async () => {
      add({});
      names.unavailable = true;
      const lines = (await text(must(await exportOf({})))).trim().split('\r\n');
      expect(lines[1]!.split(',')[1]).toBe(`Seller ${SELLER_A}`);
    });

    it('refuses more than 200 ids, a repeated id and an id that is not one', async () => {
      const a = add({});
      const many = Array.from({ length: 201 }, (_, i) => id<'Payout'>(0x5000 + i)).join(',');
      expect(await exportOf({ ids: many })).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 200 },
      });
      expect(await exportOf({ ids: `${a.id},${a.id}` })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'duplicate' }] },
      });
      expect(await exportOf({ ids: `${a.id},nope` })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'ids', code: 'format' }] },
      });
      expect(reader.reads).toBe(0);
    });

    it('refuses a selector key of the list it cannot read, and a failed store search, before reading', async () => {
      expect(await exportOf({ view: 'archived', sort: 'store' })).toMatchObject({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: expect.arrayContaining([
            { path: 'view', code: 'value' },
            { path: 'sort', code: 'value' },
          ]) as unknown,
        },
      });
      search.failing = true;
      expect(await exportOf({ search: 'spice' })).toEqual({
        ok: false,
        error: { code: 'commission-payouts.search-unavailable' },
      });
      expect(reader.reads).toBe(0);
    });

    it('takes exactly 10,000 payouts', async () => {
      reader.idsPage = () =>
        Promise.resolve(Array.from({ length: 10_000 }, (_, i) => id<'Payout'>(0x9000 + i)));
      reader.byIds = () => Promise.resolve([]);
      const file = must(await exportOf({}));
      expect((await text(file)).trim().split('\r\n')).toHaveLength(1);
    });

    it('refuses a store search that matched more stores than it carries', async () => {
      add({});
      search.capped = true;
      expect(await exportOf({ search: 'spice' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'search', code: 'too-broad' }] },
      });
    });

    it('writes a store name that starts a formula as inert text, in CSV and XLSX', async () => {
      names.names.set(SELLER_A, '=HYPERLINK("http://x.test","a")');
      names.names.set(SELLER_B, '@SUM(1)');
      const a = add({ minutes: 1 });
      const b = add({ sellerId: SELLER_B, minutes: 2 });
      const lines = (await text(must(await exportOf({}))))
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[1]).toContain(`${b.id},'@SUM(1)`);
      expect(lines[2]).toContain(`${a.id},"'=HYPERLINK(""http://x.test"",""a"")"`);
      const file = must(await exportOf({ format: 'xlsx' }));
      const parts: Uint8Array[] = [];
      for await (const chunk of file.chunks)
        parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
      const sheet = book.worksheets[0]!;
      for (const row of [2, 3]) {
        const cell = sheet.getRow(row).getCell(2);
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.formula).toBeUndefined();
      }
    });

    it('writes an XLSX file of the same rows', async () => {
      add({});
      const file = must(await exportOf({ format: 'xlsx' }));
      expect(file.filename).toBe('payouts-2026-11-02.xlsx');
      let bytes = 0;
      for await (const chunk of file.chunks) bytes += chunk.length;
      expect(bytes).toBeGreaterThan(0);
    });

    it('is for admins only', async () => {
      expect(await exportOf({}, actorOf(market, 'seller'))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });
});

describe('decimalOf', () => {
  it.each([
    [12345n, 'AUD', '123.45'],
    [5n, 'AUD', '0.05'],
    [0n, 'AUD', '0.00'],
    [12345n, 'JPY', '12345'],
    [1234n, 'KWD', '1.234'],
    [-150n, 'AUD', '-1.50'],
  ])('writes %s %s as %s', (amount, currency, expected) => {
    expect(decimalOf(amount, currency)).toBe(expected);
  });
});

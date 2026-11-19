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
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { AccountDeletionRequestStatus } from '../domain/account-deletion-request';
import {
  DELETION_ROW_KEYS,
  encodeDeletionListCursor,
  exportAdminDeletionRequests,
  listAdminDeletionRequests,
  type AdminDeletionListDependencies,
  type AdminDeletionListPage,
} from './admin-deletion-list-flow';
import {
  MemoryAccountDeletionRequests,
  type StoredDeletionRequest,
} from './testing/in-memory-account-deletion';
import { MemoryAdminDeletionList } from './testing/in-memory-deletion-list';

// The admin Account deletion requests super list (phase 4, list 25) and its export, on both
// Market fixtures. Nothing here cancels or carries out a request: the row actions only name what
// the caller may open, and no ticket, admin reason or personal data is read.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa1);
const TICKET = 'SUP-4242';
const WHY = 'Buyer wrote to support from a known address';

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}
const linesOf = async (file: ExportFile) =>
  (await text(file))
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter(Boolean);

describe.each([['AU'], ['ZZ']] as const)(
  'the admin Account deletion requests list in %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const adminIn = (m: MarketContext = market): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: id<'Session'>(0x61),
          sellerId: null,
        }),
        'deletion-list',
      );
    const admin = adminIn();

    let requests: MemoryAccountDeletionRequests;
    let reader: MemoryAdminDeletionList;
    let cancel: ScriptedProbe;
    let deps: AdminDeletionListDependencies;
    let n: number;

    beforeEach(() => {
      requests = new MemoryAccountDeletionRequests();
      reader = new MemoryAdminDeletionList(requests);
      cancel = new ScriptedProbe(true);
      const [cancelKey] = DELETION_ROW_KEYS;
      deps = {
        unitOfWork: new FakeUnitOfWork(),
        list: reader,
        probes: { [cancelKey]: cancel },
        sheetWriter: new ExceljsSheetWriter(),
        clock: new FixedClock(T0.add({ hours: 1 })),
      };
      n = 0;
    });

    /** A request of the Market asked `hours` after T0, deleting 30 days later; pending by default. */
    const add = (
      fields: {
        readonly status?: AccountDeletionRequestStatus;
        readonly hours?: number;
        readonly by?: 'customer' | 'admin';
        readonly cancelReason?: 'customer' | 'sign-in' | 'admin';
        readonly closedHours?: number;
      } = {},
      m: MarketContext = market,
    ): StoredDeletionRequest => {
      n += 1;
      const at = T0.add({ hours: fields.hours ?? n });
      const status = fields.status ?? 'pending';
      const closed = status === 'cancelled' || status === 'completed';
      const by = fields.by ?? 'customer';
      const row: StoredDeletionRequest = {
        id: id<'AccountDeletionRequest'>(0x1000 + n),
        accountId: id<'Account'>(0x2000 + n),
        status,
        waitingPeriodDays: 30,
        requestedAt: at,
        scheduledFor: at.add({ hours: 30 * 24 }),
        claimedAt: status === 'executing' ? at.add({ hours: 30 * 24 }) : null,
        requestedBy: by,
        adminOrigin:
          by === 'admin' ? { adminAccountId: ADMIN, ticketRef: TICKET, reason: WHY } : null,
        market: m.marketId,
        closedAt: closed ? at.add({ hours: fields.closedHours ?? 2 }) : null,
        cancelReason: status === 'cancelled' ? (fields.cancelReason ?? 'customer') : null,
        cancelledByAdmin: fields.cancelReason === 'admin' ? { adminAccountId: ADMIN } : null,
        redactedAt: null,
      };
      requests.rows.set(row.id, row);
      return row;
    };

    const list = (input: Record<string, unknown>, context: CallContext = admin) =>
      listAdminDeletionRequests(deps, context, input);
    const ids = (page: AdminDeletionListPage) => page.entries.map((row) => row.id);

    describe('reading', () => {
      it('opens on the pending view, earliest deletion first, with counts per view and no personal data', async () => {
        const late = add({ hours: 5, by: 'admin' });
        const early = add({ hours: 1 });
        add({ status: 'cancelled' });
        add({ status: 'completed' });
        add({ status: 'executing' });
        add({}, otherMarket);
        const page = must(await list({}));
        expect(ids(page)).toEqual([early.id, late.id]);
        expect(page.counts).toEqual({
          pending: 2,
          executing: 1,
          cancelled: 1,
          completed: 1,
          all: 5,
        });
        expect(page).toMatchObject({ total: 2, page: 1, pageSize: 25, nextCursor: null });
        expect(page.entries[1]).toEqual({
          id: late.id,
          accountId: late.accountId,
          status: 'pending',
          requestedBy: 'admin',
          requestedAt: late.requestedAt,
          scheduledFor: late.scheduledFor,
          cancelledAt: null,
          cancelReason: null,
          completedAt: null,
          actions: ['cancel'],
        });
        const json = JSON.stringify(page);
        expect(json).not.toContain(TICKET);
        expect(json).not.toContain(WHY);
      });

      it('shows each view, and all of them, of its own Market only', async () => {
        const pending = add();
        const executing = add({ status: 'executing' });
        const cancelled = add({ status: 'cancelled', cancelReason: 'sign-in' });
        const completed = add({ status: 'completed' });
        add({ status: 'completed' }, otherMarket);
        expect(ids(must(await list({ view: 'executing' })))).toEqual([executing.id]);
        const c = must(await list({ view: 'cancelled' }));
        expect(ids(c)).toEqual([cancelled.id]);
        expect(c.entries[0]).toMatchObject({
          cancelReason: 'sign-in',
          cancelledAt: cancelled.closedAt,
          completedAt: null,
        });
        const d = must(await list({ view: 'completed' }));
        expect(d.entries[0]).toMatchObject({ completedAt: completed.closedAt, cancelledAt: null });
        const all = must(await list({ view: 'all' }));
        expect(new Set(ids(all))).toEqual(
          new Set([pending.id, executing.id, cancelled.id, completed.id]),
        );
        expect(all.total).toBe(4);
      });

      it('offers Cancel only on a waiting request, and only to a holder of the delete key', async () => {
        add();
        add({ status: 'executing' });
        add({ status: 'cancelled' });
        const all = must(await list({ view: 'all' }));
        expect(all.entries.map((row) => [row.status, row.actions])).toEqual(
          expect.arrayContaining([
            ['pending', ['cancel']],
            ['executing', []],
            ['cancelled', []],
          ]),
        );
        cancel.held = false;
        const plain = must(await list({ view: 'all' }));
        expect(plain.entries.every((row) => row.actions.length === 0)).toBe(true);
      });

      it('filters by who asked, why it was cancelled, an exact id and the dates', async () => {
        const byAdmin = add({ by: 'admin', hours: 1 });
        const byBuyer = add({ hours: 10 });
        const signIn = add({ status: 'cancelled', cancelReason: 'sign-in', hours: 3 });
        add({ status: 'cancelled', cancelReason: 'admin', hours: 4 });
        expect(ids(must(await list({ requestedBy: 'admin' })))).toEqual([byAdmin.id]);
        expect(ids(must(await list({ view: 'all', cancelReason: 'sign-in' })))).toEqual([
          signIn.id,
        ]);
        expect(ids(must(await list({ q: byBuyer.id })))).toEqual([byBuyer.id]);
        expect(ids(must(await list({ q: byBuyer.accountId.toUpperCase() })))).toEqual([byBuyer.id]);
        const narrowed = must(
          await list({
            from: T0.add({ hours: 2 }).toString(),
            to: T0.add({ hours: 11 }).toString(),
          }),
        );
        expect(ids(narrowed)).toEqual([byBuyer.id]);
        expect(narrowed.total).toBe(1);
        expect(ids(must(await list({ scheduledBefore: byBuyer.scheduledFor.toString() })))).toEqual(
          [byAdmin.id],
        );
      });

      it('sorts by each key, closed dates last either way', async () => {
        const a = add({ status: 'cancelled', hours: 1, closedHours: 9 });
        const b = add({ status: 'cancelled', hours: 2, closedHours: 1 });
        const c = add({ hours: 3 });
        const view = { view: 'all' };
        expect(ids(must(await list({ ...view, sort: 'requested' })))).toEqual([c.id, b.id, a.id]);
        expect(ids(must(await list({ ...view, sort: 'requested', direction: 'asc' })))).toEqual([
          a.id,
          b.id,
          c.id,
        ]);
        expect(ids(must(await list({ ...view, sort: 'scheduled', direction: 'desc' })))).toEqual([
          c.id,
          b.id,
          a.id,
        ]);
        // a closed at T0+10h, b at T0+3h: newest first, the open one last.
        expect(ids(must(await list({ ...view, sort: 'cancelled' })))).toEqual([a.id, b.id, c.id]);
        expect(ids(must(await list({ ...view, sort: 'cancelled', direction: 'asc' })))).toEqual([
          b.id,
          a.id,
          c.id,
        ]);
        expect(ids(must(await list({ ...view, sort: 'completed' })))[2]).toBeDefined();
      });

      it('pages by numbers with a total, and by Previous/Next with the older cursor', async () => {
        const rows = [1, 2, 3, 4, 5].map((hours) => add({ hours }));
        const second = must(await list({ page: 2, pageSize: 2 }));
        expect(ids(second)).toEqual([rows[2]!.id, rows[3]!.id]);
        expect(second).toMatchObject({ total: 5, page: 2, pageSize: 2, nextCursor: null });
        const first = must(await list({ limit: 2 }));
        expect(ids(first)).toEqual([rows[0]!.id, rows[1]!.id]);
        expect(first).toMatchObject({ total: null, page: null, pageSize: 2 });
        expect(first.nextCursor).toBe(
          encodeDeletionListCursor({ scheduledFor: rows[1]!.scheduledFor, id: rows[1]!.id }),
        );
        const next = must(await list({ limit: 2, cursor: first.nextCursor }));
        expect(ids(next)).toEqual([rows[2]!.id, rows[3]!.id]);
        const last = must(await list({ limit: 2, cursor: next.nextCursor }));
        expect(ids(last)).toEqual([rows[4]!.id]);
        expect(last.nextCursor).toBeNull();
        expect(must(await list({ cursor: first.nextCursor })).pageSize).toBe(20);
      });

      it('accepts the older `status=pending` and asks the probe nothing on an empty page', async () => {
        expect(must(await list({ status: 'pending' })).entries).toEqual([]);
        const spy = jest.spyOn(cancel, 'execute');
        must(await list({}));
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('refusals', () => {
      const fieldsOf = async (input: Record<string, unknown>) => {
        const result = await list(input);
        if (result.ok) throw new Error('expected a refusal');
        return result.error;
      };

      it.each([
        [{ view: 'open' }, 'view', 'value'],
        [{ status: 'executing' }, 'status', 'value'],
        [{ status: 'pending', view: 'all' }, 'status', 'with-view'],
        [{ requestedBy: 'seller' }, 'requestedBy', 'value'],
        [{ cancelReason: 'other' }, 'cancelReason', 'value'],
        [{ q: 'someone@example.com' }, 'q', 'format'],
        [{ from: '2026-11-02' }, 'from', 'format'],
        [{ from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z' }, 'to', 'range'],
        [{ scheduledBefore: 'soon' }, 'scheduledBefore', 'format'],
        [{ sort: 'account' }, 'sort', 'value'],
        [{ direction: 'up' }, 'direction', 'value'],
        [{ page: 0 }, 'page', 'range'],
        [{ pageSize: 101 }, 'pageSize', 'range'],
        [{ page: 101, pageSize: 100 }, 'page', 'too-deep'],
        [{ limit: 0 }, 'limit', 'range'],
        [{ limit: '5' }, 'limit', 'range'],
        [{ cursor: 'garbage' }, 'cursor', 'format'],
        [{ limit: 5, page: 1 }, 'page', 'with-cursor'],
        [{ limit: 5, sort: 'requested' }, 'sort', 'with-cursor'],
      ])('refuses %j at %s (%s) before any read', async (input, path, code) => {
        expect(await fieldsOf(input)).toEqual({
          code: 'validation.failed',
          fields: expect.arrayContaining([{ path, code }]) as unknown,
        });
        expect(reader.reads).toBe(0);
      });

      it('refuses a buyer, a seller and an acting-as session', async () => {
        const buyer = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'customer',
            accountId: id<'Account'>(0xb1),
            sessionId: id<'Session'>(0x62),
            sellerId: null,
          }),
          'deletion-list',
        );
        const seller = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId: ADMIN,
            sessionId: id<'Session'>(0x63),
            sellerId: id<'Seller'>(0x5e),
          }),
          'deletion-list',
        );
        const actingAs = {
          ...admin,
          actor: { ...admin.actor, actingAs: { adminAccountId: ADMIN } },
        } as unknown as CallContext;
        for (const context of [buyer, seller, actingAs]) {
          expect(await list({}, context)).toEqual({ ok: false, error: { code: 'access.denied' } });
          expect(await exportAdminDeletionRequests(deps, context, { format: 'csv' })).toEqual({
            ok: false,
            error: { code: 'access.denied' },
          });
        }
        expect(reader.reads).toBe(0);
      });
    });

    describe('the export', () => {
      const exportOf = (input: Record<string, unknown>) =>
        exportAdminDeletionRequests(deps, admin, input);

      it('writes the view in the list sort as CSV, with the chosen columns and no ticket or reason', async () => {
        const late = add({ hours: 5, by: 'admin' });
        const early = add({ hours: 1 });
        add({ status: 'cancelled' });
        add({}, otherMarket);
        const file = must(await exportOf({ format: 'csv' }));
        expect(file.filename).toBe('deletion-requests-2026-11-02.csv');
        const lines = await linesOf(file);
        expect(lines).toEqual([
          'Request ID,Account ID,Status,Requested by,Requested (UTC),Deletes on (UTC)',
          `${early.id},${early.accountId},Waiting,Buyer,${early.requestedAt.toString()},${early.scheduledFor.toString()}`,
          `${late.id},${late.accountId},Waiting,Admin,${late.requestedAt.toString()},${late.scheduledFor.toString()}`,
        ]);
        expect(lines.join('\n')).not.toContain(TICKET);
        expect(lines.join('\n')).not.toContain(WHY);
      });

      it('adds the closed columns and labels each cancel reason', async () => {
        const signIn = add({ status: 'cancelled', cancelReason: 'sign-in', hours: 1 });
        const done = add({ status: 'completed', hours: 2 });
        const lines = await linesOf(
          must(
            await exportOf({
              view: 'all',
              sort: 'requested',
              direction: 'asc',
              columns: 'cancelled,cancel-reason,completed',
            }),
          ),
        );
        expect(lines[0]).toBe(
          'Request ID,Account ID,Status,Requested by,Requested (UTC),Deletes on (UTC),Cancelled (UTC),Cancelled by,Deleted (UTC)',
        );
        expect(
          lines[1]!.endsWith(
            `,Cancelled,Buyer,${signIn.requestedAt.toString()},${signIn.scheduledFor.toString()},${signIn.closedAt!.toString()},Buyer signed in,`,
          ),
        ).toBe(true);
        expect(
          lines[2]!.endsWith(
            `,Deleted,Buyer,${done.requestedAt.toString()},${done.scheduledFor.toString()},,,${done.closedAt!.toString()}`,
          ),
        ).toBe(true);
      });

      it('writes the chosen ids in the order given, and refuses an id of another Market', async () => {
        const a = add({ hours: 1 });
        const b = add({ status: 'completed', hours: 2 });
        const foreign = add({}, otherMarket);
        const lines = await linesOf(must(await exportOf({ ids: `${b.id},${a.id}` })));
        expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([b.id, a.id]);
        expect(await exportOf({ ids: `${a.id},${foreign.id}` })).toEqual({
          ok: false,
          error: { code: 'customers.account-deletion-request-not-found' },
        });
      });

      it('writes an XLSX file of strings only', async () => {
        add();
        const xlsx = must(await exportOf({ format: 'xlsx' }));
        expect(xlsx.filename).toBe('deletion-requests-2026-11-02.xlsx');
        const parts: Buffer[] = [];
        for await (const chunk of xlsx.chunks) {
          parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
        }
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
        const sheet = book.getWorksheet('Deletion requests')!;
        expect(sheet.rowCount).toBe(2);
        const values: unknown[] = [];
        sheet.eachRow((row) =>
          row.eachCell((cell) => {
            values.push(cell.value);
          }),
        );
        expect(values.every((value) => typeof value === 'string')).toBe(true);
      });

      it.each([
        [{ format: 'pdf' }],
        [{ columns: 'reason' }],
        [{ ticket: 'x' }],
        [{ page: 2 }],
        [{ ids: 'not-an-id' }],
        [{ view: 'open' }],
      ])('refuses %j', async (input) => {
        const result = await exportOf(input);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      });

      it('refuses more than 200 chosen ids and a repeated id', async () => {
        const many = Array.from({ length: 201 }, (_, i) =>
          id<'AccountDeletionRequest'>(0x5000 + i),
        );
        expect((await exportOf({ ids: many.join(',') })).ok).toBe(false);
        const a = add();
        expect((await exportOf({ ids: `${a.id},${a.id}` })).ok).toBe(false);
      });

      it('refuses more than 10,000 matching requests with the total', async () => {
        jest
          .spyOn(reader, 'idsPage')
          .mockResolvedValue(
            Array.from({ length: 10_001 }, (_, i) => id<'AccountDeletionRequest'>(0x10000 + i)),
          );
        jest.spyOn(reader, 'count').mockResolvedValue(12_345);
        expect(await exportOf({ view: 'all' })).toEqual({
          ok: false,
          error: { code: 'batch.too-large', max: 10_000, total: 12_345 },
        });
      });
    });
  },
);

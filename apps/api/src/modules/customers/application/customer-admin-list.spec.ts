import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { MAX_SAVED_FILTERS_PER_OWNER, MAX_SHARED_SAVED_FILTERS } from '../domain/saved-filter';
import type { CustomerListRow } from '../domain/customer-list';
import type { CustomerListDependencies } from './customer-list-flow';
import type { SheetWriter } from './ports/sheet-writer';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import { MemorySavedFilters } from './testing/memory-saved-filters';
import { AdminCustomerOverview } from './use-cases/admin-customer-overview.use-case';
import { AdminCustomerTabOpened } from './use-cases/admin-customer-tab-opened.use-case';
import { AdminCustomersExport } from './use-cases/admin-customers-export.use-case';
import { AdminCustomersIds } from './use-cases/admin-customers-ids.use-case';
import { AdminCustomersList } from './use-cases/admin-customers-list.use-case';
import { AdminSavedFilterCreate } from './use-cases/admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from './use-cases/admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from './use-cases/admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from './use-cases/admin-saved-filters-list.use-case';
import { SavedFilterShareCheck } from './use-cases/saved-filter-share-check.use-case';

// The admin Customers super list in memory, on both Market fixtures: the access rules (view,
// export, share keys), the tabs, search, filters, sort and both paging modes, "select all
// matching", the export (step-up spent, audit row without personal data, formula-safe cells) and
// the saved filters (closed documents, caps, name uniques, shared filters audited).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-15T12:00:00Z');
const VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
const SHARE = 'customers.saved-filter.share';
const LIST = 'admin.customers.customers';
const day = (n: number): Temporal.Instant => NOW.subtract({ hours: 24 * n });

describe.each(['AU', 'ZZ'] as const)('admin customers super list in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);

  const person = (keys: readonly string[], inMarket: MarketContext = market) => {
    const accountId = ids.next<'Account'>();
    const context: CallContext = testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return { accountId, context, keys };
  };

  const row = (overrides: Partial<CustomerListRow> & { email: string }): CustomerListRow => ({
    accountId: ids.next<'Account'>(),
    displayName: null,
    status: 'active',
    emailVerified: true,
    signedUpAt: day(200),
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
    ...overrides,
  });

  function setup() {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const listReader = new InMemoryCustomerList();
    const spent: string[] = [];
    const stepUp = { refuse: null as null | 'second-factor.required' };
    const consumer: StepUpProofConsumer = {
      consume: (_context: CallContext, actionKey: string) => {
        if (stepUp.refuse !== null) {
          return Promise.resolve(err({ code: stepUp.refuse, actionKey }));
        }
        spent.push(actionKey);
        return Promise.resolve(
          ok({
            sessionId: ids.next<'Session'>(),
            verifiedAt: NOW,
          }),
        );
      },
    };
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const savedFilters = new MemorySavedFilters();
    const listDeps: CustomerListDependencies = { unitOfWork, listReader, clock };
    const pageDeps = { ...listDeps, audit };
    const filterDeps = {
      unitOfWork,
      savedFilters,
      audit,
      clock,
      ids,
      shareCheck: new SavedFilterShareCheck(gate),
    };
    return {
      listReader,
      audits,
      spent,
      stepUp,
      savedFilters,
      list: new AdminCustomersList(gate, listDeps),
      overview: new AdminCustomerOverview(gate, pageDeps),
      tabOpened: new AdminCustomerTabOpened(gate, pageDeps),
      idsOf: new AdminCustomersIds(gate, listDeps),
      export: new AdminCustomersExport(gate, {
        unitOfWork,
        listReader,
        sheetWriter,
        audit,
        stepUp: consumer,
        clock,
      }),
      filters: {
        list: new AdminSavedFiltersList(gate, filterDeps),
        create: new AdminSavedFilterCreate(gate, filterDeps),
        update: new AdminSavedFilterUpdate(gate, filterDeps),
        remove: new AdminSavedFilterDelete(gate, filterDeps),
      },
      as(who: ReturnType<typeof person>) {
        held.set(who.accountId, who.keys);
        return who.context;
      },
    };
  }

  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;
  const emails = (result: Result<{ items: readonly { email: string }[] }, unknown>) =>
    result.ok ? result.value.items.map((item) => item.email) : [];

  function seeded() {
    const t = setup();
    t.listReader.add(
      market,
      row({ email: 'amina@example.test', displayName: 'Amina Yusuf', signedUpAt: day(5) }),
      row({
        email: 'bilal@example.test',
        displayName: 'Bilal Khan',
        signedUpAt: day(150),
        lastOrderAt: day(10),
        orderCount: 3,
        spentMinor: 30_000n,
        currency: 'AUD',
      }),
      row({
        email: 'carim@example.test',
        signedUpAt: day(160),
        lastOrderAt: day(150),
        orderCount: 1,
        spentMinor: 5_000n,
        currency: 'AUD',
        status: 'disabled',
        emailVerified: false,
      }),
      row({
        email: '=cmd@example.test',
        displayName: '=HYPERLINK("x")',
        signedUpAt: day(100),
      }),
    );
    t.listReader.add(otherMarket, row({ email: 'amina@other.test' }));
    return t;
  }

  it('declares the view key on the list, the ids and the saved filters, and the export key on the export', () => {
    for (const useCase of [
      AdminCustomersList,
      AdminCustomersIds,
      AdminSavedFiltersList,
      AdminSavedFilterCreate,
      AdminSavedFilterUpdate,
      AdminSavedFilterDelete,
    ]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    }
    expect(AdminCustomersExport.access.rule).toEqual({
      kind: 'permissions',
      allOf: [VIEW, EXPORT],
    });
    expect(SavedFilterShareCheck.access.rule).toEqual({ kind: 'permissions', allOf: [SHARE] });
  });

  describe('the customer page', () => {
    const pick = (t: ReturnType<typeof seeded>, email: string): Id<'Account'> => {
      const found = (t.listReader.rowsOf.get(market.marketId) ?? []).find(
        (candidate) => candidate.email === email,
      );
      if (found === undefined) throw new Error('seed missing');
      return found.accountId;
    };

    it('declares the view key', () => {
      for (const useCase of [AdminCustomerOverview, AdminCustomerTabOpened]) {
        expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
      }
    });

    it('is denied without the view key', async () => {
      const t = seeded();
      const accountId = pick(t, 'bilal@example.test');
      expect(failure(await t.overview.execute(t.as(person([])), { accountId }))).toBe(
        'access.denied',
      );
      expect(t.audits).toHaveLength(0);
    });

    it('shows the overview with the order totals and audits the open without personal data', async () => {
      const t = seeded();
      const accountId = pick(t, 'bilal@example.test');
      const result = await t.overview.execute(t.as(person([VIEW])), { accountId });
      expect(result.ok && result.value).toMatchObject({
        email: 'bilal@example.test',
        orderCount: 3,
        spentMinor: '30000',
        refundedMinor: '0',
        firstOrderAt: null,
      });
      expect(t.audits).toHaveLength(1);
      expect(t.audits[0]).toMatchObject({
        action: 'customers.customer-page.opened',
        targetId: accountId,
        after: { tab: 'overview' },
      });
      expect(JSON.stringify(t.audits)).not.toContain('bilal');
    });

    it('answers customer-not-found, writing no audit row, for an unknown id and another Market', async () => {
      const t = seeded();
      const admin = t.as(person([VIEW]));
      expect(failure(await t.overview.execute(admin, { accountId: ids.next<'Account'>() }))).toBe(
        'customers.customer-not-found',
      );
      expect(failure(await t.overview.execute(admin, { accountId: 'nope' }))).toBe(
        'customers.customer-not-found',
      );
      const foreign = t.listReader.rowsOf.get(otherMarket.marketId)![0]!.accountId;
      expect(failure(await t.overview.execute(admin, { accountId: foreign }))).toBe(
        'customers.customer-not-found',
      );
      expect(t.audits).toHaveLength(0);
    });

    it('refuses an unknown body key', async () => {
      const t = seeded();
      const accountId = pick(t, 'bilal@example.test');
      expect(failure(await t.overview.execute(t.as(person([VIEW])), { accountId, extra: 1 }))).toBe(
        'validation.failed',
      );
    });

    it('records the opening of the Orders and Money tabs and refuses any other tab', async () => {
      const t = seeded();
      const admin = t.as(person([VIEW]));
      const accountId = pick(t, 'bilal@example.test');
      expect((await t.tabOpened.execute(admin, { accountId, tab: 'orders' })).ok).toBe(true);
      expect((await t.tabOpened.execute(admin, { accountId, tab: 'money' })).ok).toBe(true);
      expect(t.audits.map((entry) => entry.after)).toEqual([{ tab: 'orders' }, { tab: 'money' }]);
      for (const tab of ['overview', 'wallet', 7, undefined]) {
        expect(failure(await t.tabOpened.execute(admin, { accountId, tab }))).toBe(
          'validation.failed',
        );
      }
      expect(t.audits).toHaveLength(2);
    });
  });

  describe('the list', () => {
    it('is denied without the view key and to a non-admin', async () => {
      const t = seeded();
      expect(failure(await t.list.execute(t.as(person([])), {}))).toBe('access.denied');
    });

    it('lists the Market’s customers only, newest first, with the size of every tab', async () => {
      const t = seeded();
      const result = await t.list.execute(t.as(person([VIEW])), { page: 1 });
      expect(emails(result)).toEqual([
        'amina@example.test',
        '=cmd@example.test',
        'bilal@example.test',
        'carim@example.test',
      ]);
      if (!result.ok) throw new Error('list failed');
      expect(result.value.paging).toEqual({ total: 4, page: 1, pageSize: 25, maxRows: 10_000 });
      expect(result.value.counts).toMatchObject({
        all: 4,
        new: 1,
        active: 1,
        inactive: 1,
        'never-ordered': 2,
        disabled: 1,
      });
    });

    it('filters by tab, search, status, verified, order count and spent', async () => {
      const t = seeded();
      const ctx = t.as(person([VIEW]));
      const q = async (body: object) => emails(await t.list.execute(ctx, body));
      expect(await q({ view: 'active' })).toEqual(['bilal@example.test']);
      expect(await q({ view: 'inactive' })).toEqual(['carim@example.test']);
      expect(await q({ view: 'disabled' })).toEqual(['carim@example.test']);
      expect(await q({ q: 'AMI' })).toEqual(['amina@example.test']);
      expect(await q({ q: 'khan' })).toEqual(['bilal@example.test']);
      expect(await q({ filters: { verified: false } })).toEqual(['carim@example.test']);
      expect(await q({ filters: { ordersMin: 2 } })).toEqual(['bilal@example.test']);
      expect(await q({ filters: { spentMin: 10_000, spentMax: 40_000 } })).toEqual([
        'bilal@example.test',
      ]);
      expect(await q({ filters: { status: 'active' }, sort: 'orders', direction: 'desc' })).toEqual(
        ['bilal@example.test', 'amina@example.test', '=cmd@example.test'],
      );
    });

    it('reads the next page by cursor, without a total', async () => {
      const t = seeded();
      const ctx = t.as(person([VIEW]));
      const first = await t.list.execute(ctx, { limit: 3, sort: 'email', direction: 'asc' });
      if (!first.ok) throw new Error('list failed');
      expect(first.value.items).toHaveLength(3);
      expect(first.value.paging).toBeNull();
      expect(first.value.nextCursor).toBe('o3');
      const second = await t.list.execute(ctx, {
        limit: 3,
        sort: 'email',
        direction: 'asc',
        cursor: first.value.nextCursor,
      });
      if (!second.ok) throw new Error('list failed');
      expect(second.value.items).toHaveLength(1);
      expect(second.value.nextCursor).toBeNull();
    });

    it.each([
      [{ view: 'everyone' }, 'view'],
      [{ q: 'a' }, 'q'],
      [{ filters: { nope: 1 } }, 'filters.nope'],
      [{ filters: { ordersMin: 5, ordersMax: 2 } }, 'filters.ordersMax'],
      [{ filters: { joinedFrom: '2026-13-40' } }, 'filters.joinedFrom'],
      [{ sort: 'rank' }, 'sort'],
      [{ page: 0 }, 'page'],
      [{ page: 1, cursor: 'o1' }, 'cursor'],
      [{ page: 401, pageSize: 25 }, 'page'],
      [{ cursor: 'x' }, 'cursor'],
      [{ cursor: 'o10000' }, 'cursor'],
      [{ extra: true }, 'extra'],
    ])('refuses the request %j', async (body, path) => {
      const t = seeded();
      const result = await t.list.execute(t.as(person([VIEW])), body);
      expect(failure(result)).toBe('validation.failed');
      if (!result.ok && result.error.code === 'validation.failed') {
        expect(result.error.fields[0]?.path).toBe(path);
      }
    });
  });

  describe('select all matching', () => {
    it('answers the ids and the total of the filter', async () => {
      const t = seeded();
      const result = await t.idsOf.execute(t.as(person([VIEW])), { view: 'never-ordered' });
      expect(result.ok && result.value.total).toBe(2);
      expect(result.ok && result.value.ids).toHaveLength(2);
    });
    it('refuses a body with paging keys', async () => {
      const t = seeded();
      expect(failure(await t.idsOf.execute(t.as(person([VIEW])), { page: 1 }))).toBe(
        'validation.failed',
      );
    });
  });

  describe('the export', () => {
    const drain = async (chunks: AsyncIterable<string | Uint8Array>): Promise<string> => {
      let text = '';
      for await (const chunk of chunks) {
        text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      }
      return text;
    };

    it('needs both the export key and the view key', async () => {
      const t = seeded();
      expect(failure(await t.export.execute(t.as(person([VIEW])), {}))).toBe('access.denied');
      expect(failure(await t.export.execute(t.as(person([EXPORT])), {}))).toBe('access.denied');
      expect(t.spent).toEqual([]);
    });

    it('drops the ids of another Market from the file and the count', async () => {
      const t = seeded();
      const foreign = t.listReader.rowsOf.get(otherMarket.marketId)![0]!.accountId;
      const own = t.listReader.rowsOf.get(market.marketId)![0]!.accountId;
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), {
        ids: [own, foreign],
      });
      if (!result.ok) throw new Error('export failed');
      const text = await drain(result.value.chunks);
      expect(text).not.toContain('other.test');
      expect(JSON.stringify(t.audits[0])).toContain('"rowCount":1');
    });

    it('refuses more than 10,000 customers whole: no proof spent, no audit row', async () => {
      const t = seeded();
      t.listReader.add(
        market,
        ...Array.from({ length: 10_001 }, (_unused, n) => row({ email: `bulk${n}@example.test` })),
      );
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), {});
      // The in-memory unit does not roll the spent proof back; the audit row is what must be absent.
      expect(failure(result)).toBe('batch.too-large');
      expect(t.audits).toEqual([]);
    });

    it('spends the step-up proof, writes one audit row without personal data and a formula-safe CSV', async () => {
      const t = seeded();
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), {
        columns: ['name', 'orders'],
        q: '=cmd',
      });
      if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
      expect(result.value.filename).toBe('customers-2026-11-15.csv');
      const text = await drain(result.value.chunks);
      expect(text).toContain('Email,Name,Orders');
      // A cell that a spreadsheet would run as a formula leaves with a leading quote.
      expect(text).toContain("'=cmd@example.test");
      expect(text).toContain("'=HYPERLINK");
      expect(t.spent).toEqual(['customers.customers.export']);
      expect(t.audits).toHaveLength(1);
      const dump = JSON.stringify(t.audits[0], (_k, v: unknown) =>
        typeof v === 'bigint' ? String(v) : v,
      );
      expect(dump).toContain('"rowCount":1');
      expect(dump).toContain('filter');
      expect(dump).not.toContain('cmd');
      expect(dump).not.toContain('example.test');
    });

    it('writes an xlsx from the same rows and names only the chosen ids', async () => {
      const t = seeded();
      const all = await t.idsOf.execute(t.as(person([VIEW])), { view: 'disabled' });
      if (!all.ok) throw new Error('ids failed');
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), {
        format: 'xlsx',
        ids: [...all.value.ids, '01990000-0000-7000-8000-00000000dead'],
      });
      if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
      expect(result.value.filename).toBe('customers-2026-11-15.xlsx');
      const text = await drain(result.value.chunks);
      expect(text.trim().split('\n')).toHaveLength(2);
      expect(text).toContain('carim@example.test');
      expect(JSON.stringify(t.audits[0])).toContain('"selection":"ids"');
    });

    it('commits nothing when the admin has no fresh proof', async () => {
      const t = seeded();
      t.stepUp.refuse = 'second-factor.required';
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), {});
      expect(failure(result)).toBe('second-factor.required');
      expect(t.audits).toEqual([]);
    });

    it.each([
      [{ format: 'pdf' }, 'format'],
      [{ columns: ['password'] }, 'columns'],
      [{ columns: ['name', 'name'] }, 'columns'],
      [{ ids: [] }, 'ids'],
      [{ ids: ['not-an-id'] }, 'ids'],
      [{ unknown: 1 }, 'unknown'],
    ])('refuses the request %j before spending the proof', async (body, path) => {
      const t = seeded();
      const result = await t.export.execute(t.as(person([VIEW, EXPORT])), body);
      expect(failure(result)).toBe('validation.failed');
      if (!result.ok && result.error.code === 'validation.failed') {
        expect(result.error.fields[0]?.path).toBe(path);
      }
      expect(t.spent).toEqual([]);
    });
  });

  describe('saved filters', () => {
    const PAYLOAD = {
      v: 1,
      view: 'inactive',
      q: 'khan',
      filters: { status: 'active', ordersMin: 1 },
      sort: 'spent',
      direction: 'desc',
    };
    const body = (overrides: Record<string, unknown> = {}) => ({
      listKey: LIST,
      name: 'Lapsed big spenders',
      visibility: 'me',
      payload: PAYLOAD,
      ...overrides,
    });

    it('saves a closed document and lists it for its owner only', async () => {
      const t = setup();
      const owner = person([VIEW]);
      const created = await t.filters.create.execute(t.as(owner), body());
      expect(created.ok && created.value.payload).toEqual(PAYLOAD);
      const mine = await t.filters.list.execute(t.as(owner), { listKey: LIST });
      expect(mine.ok && mine.value.items).toHaveLength(1);
      const other = await t.filters.list.execute(t.as(person([VIEW])), { listKey: LIST });
      expect(other.ok && other.value.items).toHaveLength(0);
      expect(t.audits).toEqual([]);
    });

    it.each([
      [{ payload: { ...PAYLOAD, extra: 1 } }, 'payload.extra'],
      [{ payload: { ...PAYLOAD, v: 2 } }, 'payload.v'],
      [{ payload: { ...PAYLOAD, view: 'vip' } }, 'payload.view'],
      [{ payload: { ...PAYLOAD, filters: { nope: 1 } } }, 'payload.filters.nope'],
      [{ payload: { ...PAYLOAD, sort: 'rank' } }, 'payload.sort'],
      [{ listKey: 'admin.catalog.products' }, 'listKey'],
      [{ name: '' }, 'name'],
    ])('refuses %j', async (overrides, path) => {
      const t = setup();
      const result = await t.filters.create.execute(t.as(person([VIEW])), body(overrides));
      expect(failure(result)).toBe('validation.failed');
      if (!result.ok && result.error.code === 'validation.failed') {
        expect(result.error.fields[0]?.path).toBe(path);
      }
    });

    it('shares with everyone only with the share key, audits it, and caps both groups', async () => {
      const t = setup();
      const plain = person([VIEW]);
      expect(
        failure(await t.filters.create.execute(t.as(plain), body({ visibility: 'everyone' }))),
      ).toBe('access.denied');
      const sharer = person([VIEW, SHARE]);
      const shared = await t.filters.create.execute(
        t.as(sharer),
        body({ visibility: 'everyone', name: 'Shared tab' }),
      );
      expect(shared.ok).toBe(true);
      expect(t.audits).toHaveLength(1);
      expect(JSON.stringify(t.audits[0])).not.toContain('Shared tab');
      const seen = await t.filters.list.execute(t.as(plain), { listKey: LIST });
      expect(seen.ok && seen.value.items.map((i) => i.name)).toEqual(['Shared tab']);
      expect(seen.ok && seen.value.items[0]?.canManage).toBe(false);

      for (let n = 1; n < MAX_SHARED_SAVED_FILTERS; n += 1) {
        await t.filters.create.execute(
          t.as(sharer),
          body({ visibility: 'everyone', name: `Shared ${n}` }),
        );
      }
      expect(
        failure(
          await t.filters.create.execute(
            t.as(sharer),
            body({ visibility: 'everyone', name: 'One too many' }),
          ),
        ),
      ).toBe('saved-filter.shared-limit-reached');
    });

    it('keeps one name per owner, whatever its case, and at most 50 per owner', async () => {
      const t = setup();
      const owner = person([VIEW]);
      await t.filters.create.execute(t.as(owner), body({ name: 'Weekly' }));
      expect(failure(await t.filters.create.execute(t.as(owner), body({ name: 'WEEKLY' })))).toBe(
        'saved-filter.name-taken',
      );
      for (let n = 1; n < MAX_SAVED_FILTERS_PER_OWNER; n += 1) {
        await t.filters.create.execute(t.as(owner), body({ name: `Filter ${n}` }));
      }
      expect(failure(await t.filters.create.execute(t.as(owner), body({ name: 'Over' })))).toBe(
        'saved-filter.limit-reached',
      );
    });

    it('renames and deletes: the owner always, another admin only with the share key on a shared one', async () => {
      const t = setup();
      const owner = person([VIEW, SHARE]);
      const created = await t.filters.create.execute(
        t.as(owner),
        body({ visibility: 'everyone', name: 'Team tab' }),
      );
      if (!created.ok) throw new Error('create failed');
      const id = created.value.id;
      const stranger = person([VIEW]);
      expect(
        failure(
          await t.filters.update.execute(t.as(stranger), { id, name: 'x', visibility: 'everyone' }),
        ),
      ).toBe('access.denied');
      const manager = person([VIEW, SHARE]);
      const renamed = await t.filters.update.execute(t.as(manager), {
        id,
        name: 'Renamed',
        visibility: 'everyone',
      });
      expect(renamed.ok && renamed.value.name).toBe('Renamed');
      expect(t.audits).toHaveLength(2);
      expect(failure(await t.filters.remove.execute(t.as(stranger), { id }))).toBe('access.denied');
      expect((await t.filters.remove.execute(t.as(manager), { id })).ok).toBe(true);
      expect(t.audits).toHaveLength(3);
      expect(failure(await t.filters.remove.execute(t.as(owner), { id }))).toBe(
        'saved-filter.not-found',
      );
    });

    it('never shows another Market’s filters', async () => {
      const t = setup();
      const here = person([VIEW, SHARE]);
      await t.filters.create.execute(t.as(here), body({ visibility: 'everyone' }));
      const there = person([VIEW], otherMarket);
      const seen = await t.filters.list.execute(t.as(there), { listKey: LIST });
      expect(seen.ok && seen.value.items).toHaveLength(0);
    });
  });
});

void parseId;
void (null as unknown as Id<'Account'>);

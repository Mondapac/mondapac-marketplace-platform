import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { ModelSellerListRepository } from '../../../../../test/support/seller-list-model';
import { FakeAccess, FakeDirectory } from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../../platform/list-export';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../../identity';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { AccessState } from '../../domain/seller-status';
import type { SellerSuperListDependencies, SellerSuperListPage } from '../seller-super-list-flow';
import {
  SellerAccountAccessRefused,
  type SellerAccountDirectory,
} from '../ports/seller-account-directory';
import type { ListedSeller } from '../ports/seller-list.repository';
import type { OnboardingAreas } from '../ports/seller-market-formats';
import type { SellerHealthStore } from '../ports/seller-health.store';
import type { AreaNameSource } from '../ports/service-area-names.repository';
import { SellerListExport } from './seller-list-export.use-case';
import { SellerListQuery } from './seller-list-query.use-case';
import { SellerStatusViewProbe } from './seller-status-view-probe.use-case';

// The admin Sellers super list (list 15) and its export in memory, on both Market fixtures: the
// seven tabs, filters, both sorts in both directions, page numbers and Previous/Next, the page
// bounds, the walk of identity's state pages (more than 100 ids, at most 20 calls), the status
// and owner only with identity.seller-access.view, fail-closed reads, and the export (columns,
// ids, too large, status hidden). The SQL is test/db/sellers-list.db-spec.ts.

const START = Temporal.Instant.from('2026-11-10T12:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const SECRET_TERM = 'canary zebra';
const SECRET_EMAIL = 'canary-owner-zebra@example.com';

const logged: string[] = [];
beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args[0]));
    });
  }
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  logged.length = 0;
});

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

const lines = async (file: ExportFile) =>
  (await text(file))
    .replace(/^\uFEFF/u, '')
    .trim()
    .split('\r\n');

describe.each(TEST_MARKET_IDS)('the Sellers super list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const holders = new Map<string, Set<string>>();
  const strict: AuthorisationCheck = {
    check: (context, declaration) => {
      const actor = context.actor;
      return Promise.resolve(
        actor.kind === 'authenticated' &&
          actor.population === 'admin' &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => holders.get(key)?.has(actor.accountId) ?? false)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const noEditedNames: AreaNameSource = {
    edited: () => Promise.resolve(new Map()),
    forget: () => {},
  };
  const areas: OnboardingAreas = {
    openCodes: () => ['open-area'],
    nameOf: (_market, area) => (area === 'open-area' ? 'Open Area' : null),
    all: () => [{ code: 'open-area', name: 'Open Area' }],
    configured: () => [],
  };
  const noHealth = {
    latest: () => Promise.resolve(new Map()),
  } as unknown as SellerHealthStore;

  function setUp(directoryOf: (directory: FakeDirectory) => SellerAccountDirectory = (d) => d) {
    // Account ids repeat across set-ups (a new id sequence each): forget the earlier grants.
    holders.clear();
    const clock = new FixedClock(START);
    const ids = new SequenceIdGenerator(clock);
    const repository = new ModelSellerListRepository();
    const access = new FakeAccess();
    const directory = new FakeDirectory(access);
    const gate = createUseCaseGate(markets, strict);
    const deps: SellerSuperListDependencies = {
      unitOfWork,
      list: repository,
      directory: directoryOf(directory),
      onboardingAreas: areas,
      healthStore: noHealth,
      clock,
      areaNames: noEditedNames,
      statusProbe: new SellerStatusViewProbe(gate),
      sheetWriter: new ExceljsSheetWriter(),
    };
    const query = new SellerListQuery(gate, deps);
    const exporter = new SellerListExport(gate, deps);

    function admin({ list = true, status = true } = {}): CallContext {
      const accountId = ids.next<'Account'>();
      const grant = (key: string) => {
        const set = holders.get(key) ?? new Set<string>();
        set.add(accountId);
        holders.set(key, set);
      };
      if (list) grant(SELLERS_SELLER_VIEW.key);
      if (status) grant(SELLER_ACCESS_VIEW.key);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    }

    let second = 0;
    /** A file, one second later than the one before; its seller id grows with it (UUID v7). */
    function add(over: Partial<ListedSeller> = {}, state: AccessState | null = 'pending') {
      second += 1;
      clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
      const at = START.add({ seconds: second });
      const row = repository.add(market, {
        sellerId: ids.next<'Seller'>(),
        origin: 'self',
        storeName: `Shop ${second}`,
        heldSlug: null,
        draftSlug: `shop-${second}`,
        serviceAreaCode: 'open-area',
        operatingTimezone: 'Australia/Brisbane',
        draftComplete: true,
        hasApprovedRevision: false,
        hasAddress: true,
        createdAt: at,
        lastChangedAt: at,
        pending: null,
        ...over,
      });
      if (state !== null) access.set(row.sellerId, state);
      return row.sellerId;
    }
    const pending = (seconds: number, kind: 'onboarding' | 'identity-change' = 'onboarding') => ({
      revisionId: ids.next<'BusinessFileRevision'>(),
      kind,
      revisionNo: 1,
      submittedAt: START.add({ seconds }),
    });

    const ask = async (input: unknown, context: CallContext = admin()) => {
      const result = await query.execute(context, input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    const idsOf = async (input: unknown, context?: CallContext) =>
      (await ask(input, context)).items.map((row) => row.sellerId);
    return {
      query,
      exporter,
      repository,
      access,
      directory,
      admin,
      add,
      pending,
      ask,
      idsOf,
    };
  }

  describe('file tabs', () => {
    it('lists all newest first, with the total, the counts, the areas, the state counts and Open', async () => {
      const t = setUp();
      const a = t.add({}, 'approved');
      const b = t.add({ draftComplete: false });
      const c = t.add({ pending: t.pending(1) });
      t.directory.owners.set(c, { displayName: 'Owner', email: 'owner@example.com' });

      const page = await t.ask({});

      expect(page.items.map((row) => row.sellerId)).toEqual([c, b, a]);
      expect(page).toMatchObject<Partial<SellerSuperListPage>>({
        tab: 'all',
        total: 3,
        page: 1,
        pageSize: 25,
        paging: 'pages',
        hasNext: false,
        counts: { awaitingReview: { onboarding: 1, identityChange: 0 }, incomplete: 1, all: 3 },
        stateCounts: { changesNeeded: 0, notApproved: 0, approved: 1, suspended: 0 },
        areas: [{ code: 'open-area', name: 'Open Area' }],
        healthUnavailable: false,
      });
      expect(page.items[0]).toMatchObject({
        status: 'awaiting-review',
        owner: { displayName: 'Owner', email: 'owner@example.com' },
        kind: 'onboarding',
        serviceAreaName: 'Open Area',
        actions: ['open'],
      });
      expect(page.items.every((row) => row.actions.join() === 'open')).toBe(true);
    });

    it('awaiting review: oldest submission first, flipped by direction, filtered by kind', async () => {
      const t = setUp();
      const late = t.add({ pending: t.pending(30) });
      const early = t.add({ pending: t.pending(10, 'identity-change') });
      const middle = t.add({ pending: t.pending(20) });
      t.add();

      expect(await t.idsOf({ view: 'awaiting-review' })).toEqual([early, middle, late]);
      expect(await t.idsOf({ view: 'awaiting-review', direction: 'desc' })).toEqual([
        late,
        middle,
        early,
      ]);
      expect(await t.idsOf({ view: 'awaiting-review', kind: 'onboarding' })).toEqual([
        middle,
        late,
      ]);
      expect((await t.ask({ view: 'awaiting-review', kind: 'identity-change' })).total).toBe(1);
    });

    it('incomplete: latest change first, the outside-area and area filters', async () => {
      const t = setUp();
      const inside = t.add({ draftComplete: false });
      const outside = t.add({ draftComplete: false, serviceAreaCode: 'closed-area' });
      const noArea = t.add({ draftComplete: false, serviceAreaCode: null });
      t.add({ draftComplete: false, serviceAreaCode: null, hasAddress: false });
      t.add({ draftComplete: true });

      expect(await t.idsOf({ view: 'incomplete', outsideArea: 'true' })).toEqual([noArea, outside]);
      expect(await t.idsOf({ view: 'incomplete', outsideArea: true })).toEqual([noArea, outside]);
      expect(
        await t.idsOf({ view: 'incomplete', direction: 'asc', areaCode: 'open-area' }),
      ).toEqual([inside]);
      expect((await t.ask({ view: 'incomplete' })).total).toBe(4);
    });

    it('sorts by name A to Z and Z to A, a nameless file last then first, ties on the seller id', async () => {
      const t = setUp();
      const beta = t.add({ storeName: 'Beta' });
      const nameless = t.add({ storeName: null });
      const alpha = t.add({ storeName: 'alpha' });
      const twinA = t.add({ storeName: 'Twin' });
      const twinB = t.add({ storeName: 'twin' });

      expect(await t.idsOf({ sort: 'name' })).toEqual([alpha, beta, twinA, twinB, nameless]);
      expect(await t.idsOf({ sort: 'name', direction: 'desc' })).toEqual([
        nameless,
        twinB,
        twinA,
        beta,
        alpha,
      ]);
      expect(await t.idsOf({ sort: 'queue', direction: 'asc' })).toEqual([
        beta,
        nameless,
        alpha,
        twinA,
        twinB,
      ]);
    });

    it('searches a store-name or slug prefix on a file tab, and refuses a too broad term', async () => {
      const t = setUp();
      const named = t.add({ storeName: `${SECRET_TERM} grocer` });
      const slugged = t.add({ storeName: 'Other', heldSlug: 'canary-deli' });
      t.add({ storeName: 'Bravo' });

      expect(await t.idsOf({ q: 'CANARY Z' })).toEqual([named]);
      expect(await t.idsOf({ q: 'canary-' })).toEqual([slugged]);
      expect(await t.ask({ q: 'nothing here' })).toMatchObject({ items: [], total: 0 });
      for (let n = 0; n < 501; n += 1) t.add({ storeName: `Broad ${n}` });
      expect(await t.query.execute(t.admin(), { q: 'broad' })).toEqual({
        ok: false,
        error: { code: 'search.too-broad' },
      });
      expect(logged.join('\n')).not.toContain('canary');
    });

    it('pages with a total, or Previous/Next without one, read by OFFSET in SQL', async () => {
      const t = setUp();
      const made: Id<'Seller'>[] = [];
      for (let n = 0; n < 7; n += 1) made.push(t.add());
      const newest = [...made].reverse();

      const third = await t.ask({ page: 3, pageSize: 3 });
      expect(third).toMatchObject({ total: 7, hasNext: false, page: 3 });
      expect(third.items.map((row) => row.sellerId)).toEqual(newest.slice(6));
      const second = await t.ask({ page: 2, pageSize: 3, paging: 'prev-next' });
      expect(second).toMatchObject({ total: null, hasNext: true });
      expect(second.items.map((row) => row.sellerId)).toEqual(newest.slice(3, 6));
      expect(await t.ask({ page: 3, pageSize: 3, paging: 'prev-next' })).toMatchObject({
        hasNext: false,
      });
      expect(await t.ask({ page: 9, pageSize: 3 })).toMatchObject({ items: [], hasNext: false });
      // Previous/Next never counts the tab.
      t.repository.calls.length = 0;
      await t.ask({ paging: 'prev-next' });
      expect(t.repository.calls.map((call) => call.method)).not.toContain('countMatching');
      const read = t.repository.calls.find((call) => call.method === 'all');
      expect(read?.query).toMatchObject({ offset: 0, take: 26, order: { key: 'queue' } });
    });

    it('refuses a bad request whole: keys, values, tabs, sorts and the page bounds', async () => {
      const t = setUp();
      t.add();
      for (const input of [
        [],
        'all',
        { nope: 1 },
        { view: 'done' },
        { kind: 'onboarding' },
        { view: 'awaiting-review', kind: 'other' },
        { outsideArea: 'true' },
        { view: 'incomplete', outsideArea: 'yes' },
        { areaCode: 'Not An Area!' },
        { view: 'approved', areaCode: 'open-area' },
        { q: 'a' },
        { q: 'bad\u0000text' },
        { view: 'approved', q: 'shop' },
        { sort: 'orders' },
        { direction: 'up' },
        { view: 'approved', sort: 'name' },
        { view: 'suspended', direction: 'asc' },
        { pageSize: 101 },
        { pageSize: 0 },
        { page: 0 },
        { page: '2' },
        { paging: 'x' },
        { page: 401, pageSize: 25 },
        { page: 101, pageSize: 100, paging: 'prev-next' },
      ]) {
        expect([input, await t.query.execute(t.admin(), input)]).toMatchObject([
          input,
          { ok: false, error: { code: 'validation.failed' } },
        ]);
      }
      // The deepest page that fits is served.
      expect((await t.query.execute(t.admin(), { page: 400, pageSize: 25 })).ok).toBe(true);
    });

    it('answers sellers.unavailable when the read fails, and never a partial page', async () => {
      const t = setUp();
      t.add();
      t.repository.failing = true;
      expect(await t.query.execute(t.admin(), {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    });
  });

  describe('the status and the owner', () => {
    it('hides them, and the state counts, without identity.seller-access.view, and asks identity nothing', async () => {
      const t = setUp();
      const one = t.add();
      t.directory.owners.set(one, { displayName: 'Owner', email: SECRET_EMAIL });

      const page = await t.ask({}, t.admin({ status: false }));

      expect(page.items[0]).toMatchObject({ status: 'hidden', owner: null });
      expect(page.stateCounts).toBeNull();
      expect(t.access.manyCalls).toHaveLength(0);
      expect(t.directory.idCalls).toHaveLength(0);
    });

    it('refuses every state tab without the key, before identity is asked', async () => {
      const t = setUp();
      t.add({}, 'approved');
      for (const view of ['changes-needed', 'not-approved', 'approved', 'suspended']) {
        expect(await t.query.execute(t.admin({ status: false }), { view })).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(t.directory.idCalls).toHaveLength(0);
    });

    it('answers sellers.unavailable when identity cannot answer, access.denied when it refuses', async () => {
      const t = setUp();
      t.add({}, 'approved');
      t.access.failing = true;
      expect(await t.query.execute(t.admin(), { view: 'approved' })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(await t.query.execute(t.admin(), {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      const refusing = setUp((directory) => ({
        accountsOf: (context, ids) => directory.accountsOf(context, ids),
        idsByState: () => Promise.reject(new SellerAccountAccessRefused('refused')),
      }));
      refusing.add({}, 'approved');
      expect(await refusing.query.execute(refusing.admin(), { view: 'approved' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('identity state tabs', () => {
    it('lists each state newest first with its count, the two rejected tabs apart', async () => {
      const t = setUp();
      const old = t.add({ hasApprovedRevision: true }, 'approved');
      const recent = t.add({ hasApprovedRevision: true }, 'approved');
      const changes = t.add({}, 'rejected');
      const done = t.add({}, 'rejected');
      t.access.set(done, 'rejected', true);
      t.add({}, 'suspended');

      const approved = await t.ask({ view: 'approved' });
      expect(approved.items.map((row) => row.sellerId)).toEqual([recent, old]);
      expect(approved).toMatchObject({
        tab: 'approved',
        total: 2,
        hasNext: false,
        stateCounts: { approved: 2, changesNeeded: 1, notApproved: 1, suspended: 1 },
      });
      expect(approved.items[0]).toMatchObject({ status: 'approved', actions: ['open'] });
      expect(await t.idsOf({ view: 'changes-needed' })).toEqual([changes]);
      expect(await t.idsOf({ view: 'not-approved' })).toEqual([done]);
      expect(await t.idsOf({ view: 'approved', sort: 'queue', direction: 'desc' })).toEqual([
        recent,
        old,
      ]);
    });

    it('walks more than 100 ids to reach a page, in identity order, with the total', async () => {
      const t = setUp();
      const made: Id<'Seller'>[] = [];
      for (let n = 0; n < 250; n += 1) made.push(t.add({}, 'approved'));
      const newest = [...made].reverse();

      const third = await t.ask({ view: 'approved', page: 3, pageSize: 100 });

      expect(third.items.map((row) => row.sellerId)).toEqual(newest.slice(200));
      expect(third).toMatchObject({ total: 250, hasNext: false });
      const calls = t.directory.idCalls.filter((call) => call.state === 'approved');
      expect(calls.map((call) => call.limit)).toEqual([100, 100, 100]);
      expect(calls[1]?.before).toBe(newest[99]);

      t.directory.idCalls.length = 0;
      const middle = await t.ask({ view: 'approved', page: 2, pageSize: 100, paging: 'prev-next' });
      expect(middle).toMatchObject({ total: null, hasNext: true });
      expect(middle.items.map((row) => row.sellerId)).toEqual(newest.slice(100, 200));
      expect(t.directory.idCalls.map((call) => call.limit)).toEqual([100, 100, 1]);
    });

    it('stops at 20 identity calls (2000 rows): deeper pages are refused, never guessed', async () => {
      const t = setUp();
      const made: Id<'Seller'>[] = [];
      for (let n = 0; n < 2050; n += 1) made.push(t.add({}, 'suspended'));
      const newest = [...made].reverse();

      const last = await t.ask({ view: 'suspended', page: 20, pageSize: 100 });
      expect(last.items.map((row) => row.sellerId)).toEqual(newest.slice(1900, 2000));
      expect(last).toMatchObject({ total: 2050, hasNext: true });
      expect(t.directory.idCalls).toHaveLength(20);

      t.directory.idCalls.length = 0;
      const prevNext = await t.ask({
        view: 'suspended',
        page: 20,
        pageSize: 100,
        paging: 'prev-next',
      });
      expect(prevNext).toMatchObject({ total: null, hasNext: true });
      expect(t.directory.idCalls).toHaveLength(20);

      t.directory.idCalls.length = 0;
      expect(
        await t.query.execute(t.admin(), { view: 'suspended', page: 21, pageSize: 100 }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(t.directory.idCalls).toHaveLength(0);
    });

    it('refuses a page identity cannot reach in 20 calls when it pages fewer ids than asked', async () => {
      const t = setUp((directory) => ({
        accountsOf: (context, ids) => directory.accountsOf(context, ids),
        // An identity that answers at most 50 ids a call, whatever the limit.
        idsByState: async (context, query) => {
          const answer = await directory.idsByState(context, {
            ...query,
            limit: Math.min(query.limit, 50),
          });
          return answer;
        },
      }));
      for (let n = 0; n < 1200; n += 1) t.add({}, 'approved');

      expect(
        (await t.query.execute(t.admin(), { view: 'approved', page: 10, pageSize: 100 })).ok,
      ).toBe(true);
      t.directory.idCalls.length = 0;
      expect(
        await t.query.execute(t.admin(), { view: 'approved', page: 11, pageSize: 100 }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page' }] },
      });
      expect(t.directory.idCalls).toHaveLength(20);
    });

    it('leaves out a seller identity pages but sellers holds no file for', async () => {
      const t = setUp();
      const kept = t.add({}, 'approved');
      const ghost = 'ffffffff-ffff-7fff-bfff-ffffffffffff' as Id<'Seller'>;
      t.access.set(ghost, 'approved');
      expect(await t.idsOf({ view: 'approved' })).toEqual([kept]);
    });
  });

  describe('the export', () => {
    it('exports the tab in its sort as CSV, with every base column and the chosen seller id', async () => {
      const t = setUp();
      const a = t.add({ storeName: '=HYPERLINK("x")', pending: t.pending(5) });
      const b = t.add({ storeName: 'Beta', heldSlug: 'beta' });
      t.directory.owners.set(a, { displayName: 'Owner A', email: 'owner-a@example.com' });

      const done = await t.exporter.execute(t.admin(), { columns: 'seller-id' });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      expect(done.value.filename).toBe('sellers-2026-11-10.csv');
      const rows = await lines(done.value);
      expect(rows[0]).toBe(
        'Store,Slug,Status,Owner name,Owner email,Kind,Submitted,Service area,Timezone,Created,' +
          'Last changed,Health band,Health score,Seller ID',
      );
      expect(rows).toHaveLength(3);
      expect(rows[1]).toContain('Beta,beta,');
      expect(rows[1]).toContain(b);
      expect(rows[2]).toContain(`'=HYPERLINK`);
      expect(rows[2]).toContain('Owner A,owner-a@example.com,onboarding,');
      expect(rows[2]).toContain('Open Area,Australia/Brisbane');

      const xlsx = await t.exporter.execute(t.admin(), { format: 'xlsx', view: 'awaiting-review' });
      expect(xlsx.ok && xlsx.value.filename).toBe('sellers-2026-11-10.xlsx');
    });

    it('leaves the status and the owner blank without identity.seller-access.view', async () => {
      const t = setUp();
      const one = t.add({ storeName: 'Shop' });
      t.directory.owners.set(one, { displayName: 'Owner', email: SECRET_EMAIL });

      const done = await t.exporter.execute(t.admin({ status: false }), {});
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const body = await text(done.value);
      expect(body).not.toContain(SECRET_EMAIL);
      expect(body).not.toContain('Owner,');
      expect(body.split('\r\n')[1]).toMatch(/^Shop,shop-\d+,,,,,/u);
      expect(t.access.manyCalls).toHaveLength(0);
      expect(await t.exporter.execute(t.admin({ status: false }), { view: 'approved' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(logged.join('\n')).not.toContain(SECRET_EMAIL);
    });

    it('exports the chosen ids in their order, refusing an unknown id, a repeat or a selector beside them', async () => {
      const t = setUp();
      const a = t.add({ storeName: 'Alpha' });
      const b = t.add({ storeName: 'Beta' });
      const done = await t.exporter.execute(t.admin(), { ids: `${a},${b}` });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const rows = await lines(done.value);
      expect(rows.slice(1).map((row) => row.split(',')[0])).toEqual(['Alpha', 'Beta']);

      const other = TEST_MARKET_IDS.find((m) => m !== code)!;
      const foreign = t.repository.add(testMarketContext(other, 'default'), {
        ...t.repository.rows.get(code)![0]!,
        sellerId: 'ffffffff-ffff-7fff-bfff-fffffffffff0' as Id<'Seller'>,
      });
      for (const unknown of [
        `${a},01990000-0000-7000-8000-0000000000ff`,
        `${a},${foreign.sellerId}`,
      ]) {
        expect(await t.exporter.execute(t.admin(), { ids: unknown })).toEqual({
          ok: false,
          error: { code: 'file.not-found' },
        });
      }
      for (const input of [
        { ids: `${a},${a}` },
        { ids: 'not-an-id' },
        { ids: [a] },
        { ids: a, view: 'all' },
        { ids: a, q: 'al' },
        { ids: a, sort: 'name' },
        { format: 'pdf' },
        { columns: 'email' },
        { page: 2 },
        { view: 'approved', sort: 'name' },
      ]) {
        expect(await t.exporter.execute(t.admin(), input)).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      const many = Array.from(
        { length: 201 },
        (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      ).join(',');
      expect(await t.exporter.execute(t.admin(), { ids: many })).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 200 },
      });
    });

    it('exports a state tab past 100 ids, newest first', async () => {
      const t = setUp();
      const made: Id<'Seller'>[] = [];
      for (let n = 0; n < 230; n += 1) made.push(t.add({ hasApprovedRevision: true }, 'approved'));
      t.add({}, 'pending');

      const done = await t.exporter.execute(t.admin(), { view: 'approved', columns: 'seller-id' });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const rows = await lines(done.value);
      expect(rows).toHaveLength(231);
      expect(rows.slice(1).map((row) => row.split(',').at(-1))).toEqual([...made].reverse());
      expect(rows[1]).toContain(',approved,');
    });

    it('refuses a selector export past 10,000 rows with the total, and the search too broad', async () => {
      const t = setUp();
      for (let n = 0; n < 10_001; n += 1) t.add({ storeName: `Broad ${n}` }, null);
      expect(await t.exporter.execute(t.admin(), {})).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 10_001 },
      });
      expect(await t.exporter.execute(t.admin(), { q: 'broad' })).toEqual({
        ok: false,
        error: { code: 'search.too-broad' },
      });
      const narrowed = await t.exporter.execute(t.admin(), { q: 'broad 9999' });
      if (!narrowed.ok) throw new Error(JSON.stringify(narrowed.error));
      expect(await lines(narrowed.value)).toHaveLength(2);
    });

    it('refuses a state tab export past 10,000 rows before reading any file', async () => {
      const t = setUp();
      for (let n = 0; n < 10_001; n += 1) {
        t.access.set(
          `01990000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Seller'>,
          'suspended',
        );
      }
      t.repository.calls.length = 0;
      expect(await t.exporter.execute(t.admin(), { view: 'suspended' })).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: 10_000, total: 10_001 },
      });
      expect(t.repository.calls).toHaveLength(0);
    });
  });

  it('turns away a caller without sellers.seller.view, list and export alike, before any read', async () => {
    const t = setUp();
    t.add();
    const outsider = t.admin({ list: false });
    expect(await t.query.execute(outsider, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await t.exporter.execute(outsider, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(t.repository.calls).toHaveLength(0);
  });

  it('never lists a seller of another Market', async () => {
    const t = setUp();
    const mine = t.add();
    const other = TEST_MARKET_IDS.find((m) => m !== code)!;
    t.repository.add(testMarketContext(other, 'default'), {
      ...t.repository.rows.get(code)![0]!,
      sellerId: 'ffffffff-ffff-7fff-bfff-fffffffffff1' as Id<'Seller'>,
    });
    expect(await t.idsOf({})).toEqual([mine]);
  });
});

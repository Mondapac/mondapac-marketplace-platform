import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { FakeAccess } from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../../identity';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import { cursorText, SEARCH_CAP, type ListCursor } from '../../domain/seller-list';
import type {
  ListCounts,
  ListedSeller,
  ListPageQuery,
  SearchCandidates,
  SellerListRepository,
} from '../ports/seller-list.repository';
import type { OnboardingAreas } from '../ports/seller-market-formats';
import { SellerList, type SellerListPage } from './list.use-case';

// The admin seller list (sellers design 7.8; slice 6) on both Market fixtures: the gate, the
// Market scope, the three tabs, paging by keyset, one identity call per page, fail-closed on an
// identity or read failure, clear fields only and a log without the search term. The SQL itself
// is covered by test/db/seller-list.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const SECRET_TERM = 'canary-term-zebra';
const SECRET_NAME = 'Canary Store Zebra';

/** In-memory rows with the filters and keyset order of the real queries. */
class FakeListRepository implements SellerListRepository {
  readonly rows = new Map<string, ListedSeller[]>();
  candidates: SearchCandidates | null = null;
  failing = false;
  calls = 0;

  add(code: string, row: ListedSeller): void {
    this.rows.set(code, [...(this.rows.get(code) ?? []), row]);
  }

  private of(market: MarketContext): ListedSeller[] {
    this.calls += 1;
    if (this.failing) throw new Error('database down');
    return [...(this.rows.get(market.marketId) ?? [])];
  }

  awaitingReview(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    const cursor = query.after;
    const rows = this.of(market)
      .filter((row) => row.pending !== null)
      .filter((row) => query.kind === null || row.pending!.kind === query.kind)
      .filter((row) => query.onlyIds === null || query.onlyIds.includes(row.sellerId))
      .sort(
        (a, b) =>
          Temporal.Instant.compare(a.pending!.submittedAt, b.pending!.submittedAt) ||
          a.pending!.revisionId.localeCompare(b.pending!.revisionId),
      )
      .filter((row) => {
        if (cursor?.tab !== 'awaiting-review') return true;
        const order =
          Temporal.Instant.compare(row.pending!.submittedAt, cursor.createdAt) ||
          row.pending!.revisionId.localeCompare(cursor.revisionId);
        return order > 0;
      });
    return Promise.resolve(rows.slice(0, query.take));
  }

  incomplete(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    const cursor = query.after;
    const open = new Set(query.openAreaCodes);
    const rows = this.of(market)
      .filter((row) => !row.hasApprovedRevision && !row.draftComplete && row.pending === null)
      .filter((row) => query.onlyIds === null || query.onlyIds.includes(row.sellerId))
      .filter(
        (row) =>
          !query.outsideArea ||
          (row.hasAddress && (row.serviceAreaCode === null || !open.has(row.serviceAreaCode))),
      )
      .sort(
        (a, b) =>
          Temporal.Instant.compare(b.lastChangedAt, a.lastChangedAt) ||
          b.sellerId.localeCompare(a.sellerId),
      )
      .filter((row) => {
        if (cursor?.tab !== 'incomplete') return true;
        const order =
          Temporal.Instant.compare(row.lastChangedAt, cursor.changedAt) ||
          row.sellerId.localeCompare(cursor.sellerId);
        return order < 0;
      });
    return Promise.resolve(rows.slice(0, query.take));
  }

  all(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    const cursor = query.after;
    const rows = this.of(market)
      .filter((row) => query.onlyIds === null || query.onlyIds.includes(row.sellerId))
      .sort((a, b) => b.sellerId.localeCompare(a.sellerId))
      .filter((row) => cursor?.tab !== 'all' || row.sellerId < cursor.sellerId);
    return Promise.resolve(rows.slice(0, query.take));
  }

  counts(market: MarketContext): Promise<ListCounts> {
    const rows = this.of(market);
    const pending = (kind: string) => rows.filter((row) => row.pending?.kind === kind).length;
    return Promise.resolve({
      awaitingReview: {
        onboarding: pending('onboarding'),
        identityChange: pending('identity-change'),
      },
      incomplete: rows.filter(
        (row) => !row.hasApprovedRevision && !row.draftComplete && row.pending === null,
      ).length,
      all: rows.length,
    });
  }

  searchCandidates(market: MarketContext): Promise<SearchCandidates> {
    this.of(market);
    return Promise.resolve(this.candidates ?? { ids: [], overflow: false });
  }
}

const ids = new SequenceIdGenerator(new FixedClock(START));
const START_MS = START.epochMilliseconds;

function row(over: Partial<ListedSeller> = {}): ListedSeller {
  return {
    sellerId: ids.next<'Seller'>(),
    origin: 'self',
    storeName: 'A shop',
    heldSlug: null,
    draftSlug: 'a-shop',
    serviceAreaCode: 'open-area',
    operatingTimezone: 'Australia/Brisbane',
    draftComplete: true,
    hasApprovedRevision: false,
    hasAddress: true,
    createdAt: START,
    lastChangedAt: START,
    pending: null,
    ...over,
  };
}

const pendingOf = (n: number, kind: 'onboarding' | 'identity-change' = 'onboarding') => ({
  revisionId: ids.next<'BusinessFileRevision'>(),
  kind,
  revisionNo: 1,
  submittedAt: Temporal.Instant.fromEpochMilliseconds(START_MS + n * 1000),
});

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

describe.each(TEST_MARKET_IDS)('sellers.list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  // Who holds which key: `sellers.seller.view` for the gate, `identity.seller-access.view` for
  // the status column. The check answers per key, as identity's does.
  const holders = new Map<string, Set<string>>();
  const holds = (key: string, accountId: string) => holders.get(key)?.has(accountId) ?? false;
  const strict: AuthorisationCheck = {
    check: (context, declaration) => {
      const actor = context.actor;
      return Promise.resolve(
        actor.kind === 'authenticated' &&
          actor.population === 'admin' &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => holds(key, actor.accountId))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const areas: OnboardingAreas = { openCodes: () => ['open-area'] };

  function setUp() {
    const repository = new FakeListRepository();
    const access = new FakeAccess();
    const useCase = new SellerList(createUseCaseGate(markets, strict), {
      unitOfWork,
      list: repository,
      accessReader: access,
      authorisation: strict,
      onboardingAreas: areas,
    });
    return { repository, access, useCase };
  }

  function admin(
    holdsList = true,
    inMarket: MarketContext = market,
    holdsStatus = true,
  ): CallContext {
    const accountId = ids.next<'Account'>();
    const grant = (key: string) => {
      const set = holders.get(key) ?? new Set<string>();
      set.add(accountId);
      holders.set(key, set);
    };
    if (holdsList) grant(SELLERS_SELLER_VIEW.key);
    if (holdsStatus) grant(SELLER_ACCESS_VIEW.key);
    return testCallContext(
      inMarket,
      testAuthenticatedActor(inMarket, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  }

  const page = (value: unknown) => value as SellerListPage;

  it('refuses an admin without sellers.seller.view and a customer, before any read', async () => {
    const t = setUp();
    t.repository.add(code, row());

    const withoutKey = await t.useCase.execute(admin(false), {});
    const customer = await t.useCase.execute(
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      ),
      {},
    );

    expect(withoutKey).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(customer).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(t.repository.calls).toBe(0);
    expect(t.access.manyCalls).toHaveLength(0);
  });

  it('lists awaiting review oldest first, with kind, status and counts, and one identity call', async () => {
    const t = setUp();
    const second = row({ pending: pendingOf(2), storeName: 'Second' });
    const first = row({ pending: pendingOf(1, 'identity-change'), hasApprovedRevision: true });
    t.repository.add(code, second);
    t.repository.add(code, first);
    t.repository.add(code, row({ draftComplete: false }));
    t.access.set(second.sellerId, 'pending');
    t.access.set(first.sellerId, 'approved');

    const result = await t.useCase.execute(admin(), {});

    expect(result.ok).toBe(true);
    const listed = page(result.ok && result.value);
    expect(listed.tab).toBe('awaiting-review');
    expect(listed.items.map((item) => [item.sellerId, item.kind, item.status])).toEqual([
      [first.sellerId, 'identity-change', 'approved'],
      [second.sellerId, 'onboarding', 'awaiting-review'],
    ]);
    expect(listed.counts).toEqual({
      awaitingReview: { onboarding: 1, identityChange: 1 },
      incomplete: 1,
      all: 3,
    });
    expect(listed.next).toBeNull();
    expect(t.access.manyCalls).toHaveLength(1);
    expect(t.access.manyCalls[0]).toEqual([first.sellerId, second.sellerId]);
  });

  describe('the status column needs identity.seller-access.view (Ali, slice 6 review)', () => {
    it('shows the status to an actor that holds both keys', async () => {
      const t = setUp();
      const r = row({ pending: pendingOf(1) });
      t.repository.add(code, r);
      t.access.set(r.sellerId, 'pending');

      const result = await t.useCase.execute(admin(true, market, true), {});

      expect(result.ok && result.value.items.map((item) => item.status)).toEqual([
        'awaiting-review',
      ]);
      expect(t.access.manyCalls).toHaveLength(1);
    });

    it('answers hidden, not null, to an actor with sellers.seller.view alone, and asks identity nothing', async () => {
      const t = setUp();
      const known = row({ pending: pendingOf(1) });
      const unknownToIdentity = row({ pending: pendingOf(2) });
      t.repository.add(code, known);
      t.repository.add(code, unknownToIdentity);
      t.access.set(known.sellerId, 'pending');

      const result = await t.useCase.execute(admin(true, market, false), {});

      expect(result.ok && result.value.items.map((item) => item.status)).toEqual([
        'hidden',
        'hidden',
      ]);
      expect(t.access.manyCalls).toHaveLength(0);
      // Everything else of the row is unchanged.
      expect(result.ok && result.value.items[0]).toMatchObject({
        sellerId: known.sellerId,
        kind: 'onboarding',
      });
    });

    it('keeps null for a seller identity does not know when the actor may see statuses', async () => {
      const t = setUp();
      const r = row();
      t.repository.add(code, r);

      const result = await t.useCase.execute(admin(true, market, true), { tab: 'all' });

      expect(result.ok && result.value.items.map((item) => item.status)).toEqual([null]);
    });

    it('is hidden, fail-closed, when the key check itself fails', async () => {
      const t = setUp();
      t.repository.add(code, row());
      const failing = new SellerList(createUseCaseGate(markets, strict), {
        unitOfWork,
        list: t.repository,
        accessReader: t.access,
        authorisation: {
          check: (context, declaration) =>
            declaration.name === 'sellers.list-status'
              ? Promise.reject(new Error('identity down'))
              : strict.check(context, declaration),
        },
        onboardingAreas: areas,
      });

      const result = await failing.execute(admin(true, market, true), { tab: 'all' });

      expect(result.ok && result.value.items.map((item) => item.status)).toEqual(['hidden']);
    });
  });

  it('filters awaiting review by kind', async () => {
    const t = setUp();
    t.repository.add(code, row({ pending: pendingOf(1) }));
    const change = row({ pending: pendingOf(2, 'identity-change'), hasApprovedRevision: true });
    t.repository.add(code, change);
    t.access.set(change.sellerId, 'approved');

    const result = await t.useCase.execute(admin(), { kind: 'identity-change' });

    expect(result.ok && result.value.items.map((item) => item.sellerId)).toEqual([change.sellerId]);
  });

  it('pages by keyset and gives a cursor that continues exactly after the last row', async () => {
    const t = setUp();
    const rows = [1, 2, 3, 4, 5].map((n) =>
      row({
        draftComplete: false,
        lastChangedAt: Temporal.Instant.fromEpochMilliseconds(START_MS + n * 1000),
      }),
    );
    rows.forEach((r) => {
      t.repository.add(code, r);
      t.access.set(r.sellerId, 'pending');
    });
    const newestFirst = [...rows].reverse().map((r) => r.sellerId);

    const first = await t.useCase.execute(admin(), { tab: 'incomplete', limit: 2 });
    const firstPage = page(first.ok && first.value);
    const second = await t.useCase.execute(admin(), {
      tab: 'incomplete',
      limit: 2,
      after: firstPage.next,
    });
    const secondPage = page(second.ok && second.value);
    const third = await t.useCase.execute(admin(), {
      tab: 'incomplete',
      limit: 2,
      after: secondPage.next,
    });
    const thirdPage = page(third.ok && third.value);

    expect(firstPage.items.map((item) => item.sellerId)).toEqual(newestFirst.slice(0, 2));
    expect(secondPage.items.map((item) => item.sellerId)).toEqual(newestFirst.slice(2, 4));
    expect(thirdPage.items.map((item) => item.sellerId)).toEqual(newestFirst.slice(4));
    expect(thirdPage.next).toBeNull();
    // One identity call per page, never one per row.
    expect(t.access.manyCalls.map((call) => call.length)).toEqual([2, 2, 1]);
    expect(firstPage.items.every((item) => item.status === 'details-incomplete')).toBe(true);
  });

  it('shows the outside-service-area status and filters on it', async () => {
    const t = setUp();
    const outside = row({ draftComplete: false, serviceAreaCode: null });
    const closed = row({ draftComplete: false, serviceAreaCode: 'closed-area' });
    const inside = row({ draftComplete: false });
    const noAddress = row({ draftComplete: false, hasAddress: false, serviceAreaCode: null });
    for (const r of [outside, closed, inside, noAddress]) {
      t.repository.add(code, r);
      t.access.set(r.sellerId, 'pending');
    }

    const all = await t.useCase.execute(admin(), { tab: 'incomplete' });
    const filtered = await t.useCase.execute(admin(), { tab: 'incomplete', outsideArea: true });

    const statusOf = (id: Id<'Seller'>) =>
      all.ok ? all.value.items.find((item) => item.sellerId === id)?.status : undefined;
    expect(statusOf(outside.sellerId)).toBe('outside-service-area');
    expect(statusOf(closed.sellerId)).toBe('outside-service-area');
    expect(statusOf(inside.sellerId)).toBe('details-incomplete');
    expect(statusOf(noAddress.sellerId)).toBe('details-incomplete');
    expect(filtered.ok && filtered.value.items.map((item) => item.sellerId).sort()).toEqual(
      [outside.sellerId, closed.sellerId].sort(),
    );
  });

  it('lists all sellers newest first, with the slug held else the draft slug', async () => {
    const t = setUp();
    const older = row({
      heldSlug: 'held-slug',
      draftSlug: 'draft-slug',
      hasApprovedRevision: true,
    });
    const newer = row({ heldSlug: null, draftSlug: 'only-draft' });
    t.repository.add(code, older);
    t.repository.add(code, newer);
    t.access.set(older.sellerId, 'suspended');
    t.access.set(newer.sellerId, 'pending');

    const result = await t.useCase.execute(admin(), { tab: 'all' });

    expect(result.ok && result.value.items.map((item) => [item.slug, item.status])).toEqual([
      ['only-draft', 'ready-to-submit'],
      ['held-slug', 'suspended'],
    ]);
  });

  it('flags an approved seller with no approved revision for the admin, and never guesses an unknown one', async () => {
    const t = setUp();
    const phase2 = row({ hasApprovedRevision: false });
    const unknown = row();
    t.repository.add(code, phase2);
    t.repository.add(code, unknown);
    t.access.set(phase2.sellerId, 'approved');

    const result = await t.useCase.execute(admin(), { tab: 'all' });

    const byId = new Map(result.ok ? result.value.items.map((item) => [item.sellerId, item]) : []);
    expect(byId.get(phase2.sellerId)?.status).toBe('file-check-needed');
    expect(byId.get(unknown.sellerId)?.status).toBeNull();
  });

  it('returns clear fields only: no business data and none of identity personal fields', async () => {
    const t = setUp();
    const r = row({ pending: pendingOf(1), storeName: 'Shop' });
    t.repository.add(code, r);
    t.access.set(r.sellerId, 'pending');

    const result = await t.useCase.execute(admin(), {});

    expect(result.ok && Object.keys(result.value.items[0]!).sort()).toEqual(
      [
        'createdAt',
        'kind',
        'lastChangedAt',
        'origin',
        'serviceAreaCode',
        'sellerId',
        'slug',
        'status',
        'storeName',
        'submittedAt',
        'timezone',
      ].sort(),
    );
  });

  it('never lists a seller of another Market', async () => {
    const t = setUp();
    const other = TEST_MARKET_IDS.find((id) => id !== code)!;
    const foreign = row({ pending: pendingOf(1) });
    t.repository.add(other, foreign);
    t.access.set(foreign.sellerId, 'pending');

    const result = await t.useCase.execute(admin(), { tab: 'all' });

    expect(result.ok && result.value.items).toEqual([]);
    expect(result.ok && result.value.counts.all).toBe(0);
  });

  describe('search', () => {
    it('lists only the candidates the search names', async () => {
      const t = setUp();
      const wanted = row({ storeName: SECRET_NAME });
      t.repository.add(code, wanted);
      t.repository.add(code, row());
      t.repository.candidates = { ids: [wanted.sellerId], overflow: false };
      t.access.set(wanted.sellerId, 'pending');

      const result = await t.useCase.execute(admin(), { tab: 'all', search: SECRET_TERM });

      expect(result.ok && result.value.items.map((item) => item.sellerId)).toEqual([
        wanted.sellerId,
      ]);
    });

    it('answers an empty list without reading a page or calling identity when nothing matches', async () => {
      const t = setUp();
      t.repository.add(code, row());

      const result = await t.useCase.execute(admin(), { tab: 'all', search: SECRET_TERM });

      expect(result.ok && result.value.items).toEqual([]);
      expect(result.ok && result.value.next).toBeNull();
      // The search found nobody: the page query is skipped and so is identity (an empty page has
      // nothing to ask about).
      expect(t.access.manyCalls).toHaveLength(0);
    });

    it('does not call identity for an empty page of a plain tab either', async () => {
      const t = setUp();

      const result = await t.useCase.execute(admin(), { tab: 'incomplete' });

      expect(result.ok && result.value.items).toEqual([]);
      expect(t.access.manyCalls).toHaveLength(0);
    });

    it('combines a search with the tab filters: kind on awaiting review', async () => {
      const t = setUp();
      const hit = row({ pending: pendingOf(1, 'identity-change'), hasApprovedRevision: true });
      const wrongKind = row({ pending: pendingOf(2) });
      const notNamed = row({ pending: pendingOf(3, 'identity-change'), hasApprovedRevision: true });
      for (const r of [hit, wrongKind, notNamed]) {
        t.repository.add(code, r);
        t.access.set(r.sellerId, 'approved');
      }
      t.repository.candidates = { ids: [hit.sellerId, wrongKind.sellerId], overflow: false };

      const result = await t.useCase.execute(admin(), {
        tab: 'awaiting-review',
        kind: 'identity-change',
        search: SECRET_TERM,
      });

      expect(result.ok && result.value.items.map((item) => item.sellerId)).toEqual([hit.sellerId]);
    });

    it('pages a search with a cursor: the second page continues inside the named sellers', async () => {
      const t = setUp();
      const named = [1, 2, 3].map((n) =>
        row({
          draftComplete: false,
          lastChangedAt: Temporal.Instant.fromEpochMilliseconds(START_MS + n * 1000),
        }),
      );
      for (const r of named) {
        t.repository.add(code, r);
        t.access.set(r.sellerId, 'pending');
      }
      t.repository.add(code, row({ draftComplete: false }));
      t.repository.candidates = { ids: named.map((r) => r.sellerId), overflow: false };
      const newestFirst = [...named].reverse().map((r) => r.sellerId);

      const one = await t.useCase.execute(admin(), {
        tab: 'incomplete',
        search: SECRET_TERM,
        limit: 2,
      });
      const firstPage = page(one.ok && one.value);
      const two = await t.useCase.execute(admin(), {
        tab: 'incomplete',
        search: SECRET_TERM,
        limit: 2,
        after: firstPage.next,
      });
      const secondPage = page(two.ok && two.value);

      expect(firstPage.items.map((item) => item.sellerId)).toEqual(newestFirst.slice(0, 2));
      expect(firstPage.next).not.toBeNull();
      expect(secondPage.items.map((item) => item.sellerId)).toEqual(newestFirst.slice(2));
      expect(secondPage.next).toBeNull();
    });

    it('keeps the counts tab-wide under a filter and under a search', async () => {
      const t = setUp();
      const change = row({ pending: pendingOf(1, 'identity-change'), hasApprovedRevision: true });
      const application = row({ pending: pendingOf(2) });
      const draft = row({ draftComplete: false });
      for (const r of [change, application, draft]) {
        t.repository.add(code, r);
        t.access.set(r.sellerId, 'pending');
      }
      t.repository.candidates = { ids: [change.sellerId], overflow: false };
      const tabWide = {
        awaitingReview: { onboarding: 1, identityChange: 1 },
        incomplete: 1,
        all: 3,
      };

      const plain = await t.useCase.execute(admin(), {});
      const filtered = await t.useCase.execute(admin(), { kind: 'identity-change' });
      const searched = await t.useCase.execute(admin(), { tab: 'all', search: SECRET_TERM });
      const outside = await t.useCase.execute(admin(), { tab: 'incomplete', outsideArea: true });

      for (const result of [plain, filtered, searched, outside]) {
        expect(result.ok && result.value.counts).toEqual(tabWide);
      }
      expect(filtered.ok && filtered.value.items).toHaveLength(1);
      expect(searched.ok && searched.value.items).toHaveLength(1);
    });

    it('refuses a term that names more than the cap, instead of cutting the list', async () => {
      const t = setUp();
      t.repository.candidates = { ids: [], overflow: true };

      const result = await t.useCase.execute(admin(), { tab: 'all', search: 'ab' });

      expect(result).toEqual({ ok: false, error: { code: 'search.too-broad' } });
      expect(SEARCH_CAP).toBe(500);
    });

    it('never logs the term or a store name', async () => {
      const t = setUp();
      const wanted = row({ storeName: SECRET_NAME });
      t.repository.add(code, wanted);
      t.repository.candidates = { ids: [wanted.sellerId], overflow: false };
      t.access.set(wanted.sellerId, 'pending');

      await t.useCase.execute(admin(), { tab: 'all', search: SECRET_TERM });

      const lines = logged.join('\n');
      expect(lines).toContain('sellers.list');
      expect(lines).not.toContain(SECRET_TERM);
      expect(lines).not.toContain('Zebra');
    });
  });

  describe('validation and failure', () => {
    it.each([
      [{ tab: 'x' }, [{ path: 'tab', code: 'value' }]],
      [{ sellerId: 'x' }, [{ path: 'sellerId', code: 'unknown-field' }]],
      [{ tab: 'all', kind: 'onboarding' }, [{ path: 'kind', code: 'tab' }]],
    ])('refuses %j as validation.failed, before any read', async (input, fields) => {
      const t = setUp();

      const result = await t.useCase.execute(admin(), input);

      expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
      expect(t.repository.calls).toBe(0);
    });

    it('is sellers.unavailable, not an empty list, when identity cannot answer', async () => {
      const t = setUp();
      t.repository.add(code, row({ pending: pendingOf(1) }));
      t.access.failing = true;

      const result = await t.useCase.execute(admin(), {});

      expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    });

    it('is sellers.unavailable when the read fails, and the log holds no driver text', async () => {
      const t = setUp();
      t.repository.failing = true;

      const result = await t.useCase.execute(admin(), {});

      expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
      expect(logged.join('\n')).not.toContain('database down');
    });

    it('treats a cursor of another tab as validation.failed', async () => {
      const t = setUp();
      const cursor: ListCursor = { tab: 'all', sellerId: ids.next<'Seller'>() };

      const result = await t.useCase.execute(admin(), {
        tab: 'incomplete',
        after: cursorText(cursor),
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] },
      });
    });
  });
});

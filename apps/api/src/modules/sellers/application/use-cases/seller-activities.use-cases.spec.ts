import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoredActivityAssignment } from '../../domain/seller-business-activities';
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import type { BusinessActivityDirectory } from '../ports/business-activity-directory';
import type {
  ActivityChangeRecord,
  SellerBusinessActivityRepository,
} from '../ports/seller-business-activity.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import { SellerActivitiesGetUseCase } from './seller-activities-get.use-case';
import { SellerActivitiesSetUseCase } from './seller-activities-set.use-case';
import { SellerBusinessActivities } from './seller-business-activities.use-case';
import { SellerBusinessActivitiesSystem } from './seller-business-activities-system.use-case';

// A seller's business activities (ADR-0040 decision 4; package 4a) in memory, on both Market
// fixtures. The PostgreSQL table, its CHECKs and grants are covered by
// test/db/seller-business-activities.db-spec.ts.

const START = Temporal.Instant.from('2026-11-02T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
type ActivityId = Id<'BusinessActivity'>;
type ChangeLogEntry = Parameters<SellerBusinessActivityRepository['appendChange']>[1];

const key = (market: MarketContext, sellerId: string): string => `${market.marketId}|${sellerId}`;

class Rows implements SellerBusinessActivityRepository {
  readonly sellers = new Set<string>();
  readonly held = new Map<string, StoredActivityAssignment>();
  readonly log: ChangeLogEntry[] = [];
  replaced = 0;

  seed(market: MarketContext, sellerId: Id<'Seller'>): void {
    this.sellers.add(key(market, sellerId));
  }

  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    return Promise.resolve(this.sellers.has(key(market, sellerId)));
  }

  find(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const found = new Map<Id<'Seller'>, StoredActivityAssignment>();
    for (const id of sellerIds) {
      const row = this.held.get(key(market, id));
      if (row !== undefined) found.set(id, row);
    }
    return Promise.resolve(found as ReadonlyMap<Id<'Seller'>, StoredActivityAssignment>);
  }

  replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    next: { mainActivityId: ActivityId; extraActivityIds: readonly ActivityId[] },
  ): Promise<void> {
    this.replaced += 1;
    this.held.set(key(market, sellerId), {
      mainActivityId: next.mainActivityId,
      extraActivityIds: next.extraActivityIds,
    });
    return Promise.resolve();
  }

  appendChange(market: MarketContext, entry: ChangeLogEntry): Promise<void> {
    this.log.push(entry);
    return Promise.resolve();
  }

  lastChange(market: MarketContext, sellerId: Id<'Seller'>): Promise<ActivityChangeRecord | null> {
    const last = this.log.filter((e) => e.sellerId === sellerId).at(-1);
    return Promise.resolve(
      last === undefined ? null : { changedBy: last.by, changedAt: last.at, reason: last.reason },
    );
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const rows = new Rows();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let held = true;
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        held ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const active = new Set<string>();
  const asked: ActivityId[][] = [];
  let directoryDown = false;
  const activityDirectory: BusinessActivityDirectory = {
    activeIds: (_context, requested) => {
      asked.push([...requested]);
      if (directoryDown) {
        return Promise.resolve(
          err({
            code: 'business-activity-directory.unavailable',
          }),
        );
      }
      return Promise.resolve(ok(new Set(requested.filter((id) => active.has(id)))));
    },
  };
  const files = {
    existingIds: (market: MarketContext, sellerIds: readonly Id<'Seller'>[]) =>
      Promise.resolve(new Set(sellerIds.filter((id) => rows.sellers.has(key(market, id))))),
  } as unknown as SellerFileRepository;
  const readDeps = { unitOfWork, businessActivities: rows };
  const request = new SellerBusinessActivities(gate, readDeps);
  const system = new SellerBusinessActivitiesSystem(gate, readDeps);
  return {
    clock,
    ids,
    rows,
    audits,
    asked,
    active,
    withhold: () => void (held = false),
    breakDirectory: () => void (directoryDown = true),
    get: new SellerActivitiesGetUseCase(gate, { unitOfWork, files, businessActivities: rows }),
    set: new SellerActivitiesSetUseCase(gate, {
      unitOfWork,
      businessActivities: rows,
      activityDirectory,
      audit,
      ids,
      clock,
    }),
    request,
    system,
    facade: new SellersFacadeImplementation({
      sellerBusinessActivities: request,
      sellerBusinessActivitiesSystem: system,
    } as unknown as ConstructorParameters<typeof SellersFacadeImplementation>[0]),
  };
}
type Setup = ReturnType<typeof setUp>;

const adminOf = (t: Setup, code: string): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId: null,
    }),
  );
};

const sellerOf = (t: Setup, code: string, sellerId: Id<'Seller'>): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
};

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each([['AU'], ['ZZ']])('seller business activities in %s', (code) => {
  const market = testMarketContext(code, 'default');

  /** A seller with a file and three active activities. */
  function withSeller() {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const [a, b, c] = [
      t.ids.next<'BusinessActivity'>(),
      t.ids.next<'BusinessActivity'>(),
      t.ids.next<'BusinessActivity'>(),
    ];
    for (const id of [a, b, c]) t.active.add(id);
    return { t, sellerId, a, b, c };
  }

  it('allows a seller with no activity to exist, and reads it as none', async () => {
    const { t, sellerId } = withSeller();
    const view = await t.get.execute(adminOf(t, code), { sellerId });
    expect(view).toEqual(ok({ mainActivityId: null, extraActivityIds: [], lastChange: null }));
    expect(
      await t.system.execute(testCallContext(market, 'system'), { sellerIds: [sellerId] }),
    ).toEqual(ok(new Map([[sellerId, { mainActivityId: null, activityIds: [] }]])));
  });

  it('assigns one main and extras, then reads them back with the reason', async () => {
    const { t, sellerId, a, b, c } = withSeller();
    const context = adminOf(t, code);
    const body = { mainActivityId: a, extraActivityIds: [c, b], reason: 'Sells meat and grocery' };
    const result = await t.set.execute(context, { sellerId, body });
    expect(result).toEqual(
      ok({ mainActivityId: a, extraActivityIds: [b, c].sort(), changed: true }),
    );
    expect(t.asked).toEqual([[a, ...[b, c].sort()]]);
    const view = await t.get.execute(context, { sellerId });
    expect(view.ok && view.value).toMatchObject({
      mainActivityId: a,
      extraActivityIds: [b, c].sort(),
      lastChange: {
        changedBy: context.actor.kind === 'authenticated' ? context.actor.accountId : '',
        changedAt: START.toString(),
        reason: 'Sells meat and grocery',
      },
    });
    expect(t.rows.log).toHaveLength(1);
    expect(t.rows.log[0]).toMatchObject({
      sellerId,
      reason: 'Sells meat and grocery',
      before: { mainActivityId: null, extraActivityIds: [] },
      after: { mainActivityId: a },
    });
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({
      action: 'sellers.business-activities.change',
      targetId: sellerId,
      before: { extraActivityIds: [] },
      after: { mainActivityId: a, extraActivityIds: [b, c].sort() },
    });
    // The reason is text: it is in the change log only, never in the audit row.
    expect(JSON.stringify(t.audits)).not.toContain('Sells meat');
  });

  it('replaces the whole set and keeps the before values in the log', async () => {
    const { t, sellerId, a, b, c } = withSeller();
    const context = adminOf(t, code);
    await t.set.execute(context, {
      sellerId,
      body: { mainActivityId: a, extraActivityIds: [b], reason: 'first' },
    });
    const second = await t.set.execute(context, {
      sellerId,
      body: { mainActivityId: c, extraActivityIds: [], reason: 'second' },
    });
    expect(second).toEqual(ok({ mainActivityId: c, extraActivityIds: [], changed: true }));
    expect(t.rows.held.get(key(market, sellerId))).toEqual({
      mainActivityId: c,
      extraActivityIds: [],
    });
    expect(t.rows.log[1]).toMatchObject({
      reason: 'second',
      before: { mainActivityId: a, extraActivityIds: [b] },
    });
  });

  it('writes nothing for the set the seller already carries', async () => {
    const { t, sellerId, a, b } = withSeller();
    const context = adminOf(t, code);
    const body = { mainActivityId: a, extraActivityIds: [b], reason: 'once' };
    await t.set.execute(context, { sellerId, body });
    const again = await t.set.execute(context, { sellerId, body: { ...body, reason: 'twice' } });
    expect(again).toEqual(ok({ mainActivityId: a, extraActivityIds: [b], changed: false }));
    expect(t.rows.replaced).toBe(1);
    expect(t.rows.log).toHaveLength(1);
    expect(t.audits).toHaveLength(1);
  });

  it('refuses a malformed body before asking catalog or writing', async () => {
    const { t, sellerId, a } = withSeller();
    const result = await t.set.execute(adminOf(t, code), {
      sellerId,
      body: { mainActivityId: a, extraActivityIds: [a], reason: '' },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'extraActivityIds.0', code: 'duplicate' },
          { path: 'reason', code: 'required' },
        ],
      },
    });
    expect(t.asked).toEqual([]);
    expect(t.rows.log).toEqual([]);
  });

  it('refuses an activity that is not active in the Market, naming the field only', async () => {
    const { t, sellerId, a, b } = withSeller();
    const unknown = t.ids.next<'BusinessActivity'>();
    t.active.delete(b);
    const result = await t.set.execute(adminOf(t, code), {
      sellerId,
      body: { mainActivityId: unknown, extraActivityIds: [a, b], reason: 'x' },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'mainActivityId', code: 'not-active' },
          ...(a < b
            ? [{ path: 'extraActivityIds.1', code: 'not-active' }]
            : [{ path: 'extraActivityIds.0', code: 'not-active' }]),
        ],
      },
    });
    expect(t.rows.held.size).toBe(0);
    expect(t.rows.log).toEqual([]);
  });

  it('fails closed when catalog cannot answer', async () => {
    const { t, sellerId, a } = withSeller();
    t.breakDirectory();
    const result = await t.set.execute(adminOf(t, code), {
      sellerId,
      body: { mainActivityId: a, extraActivityIds: [], reason: 'x' },
    });
    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
    expect(t.rows.held.size).toBe(0);
  });

  it('answers file.not-found for an unknown seller, another Market and a malformed id', async () => {
    const { t, a } = withSeller();
    const body = { mainActivityId: a, extraActivityIds: [], reason: 'x' };
    const context = adminOf(t, code);
    const unknown = t.ids.next<'Seller'>();
    expect(await t.set.execute(context, { sellerId: unknown, body })).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
    expect(await t.set.execute(context, { sellerId: 'nope', body })).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
    expect(await t.get.execute(context, { sellerId: unknown })).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
    // A seller of the other Market is not found here either.
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const foreign = t.ids.next<'Seller'>();
    t.rows.seed(testMarketContext(other, 'default'), foreign);
    expect(await t.set.execute(context, { sellerId: foreign, body })).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
    expect(await t.get.execute(context, { sellerId: foreign })).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
  });

  it('is refused to an admin without the key, a seller and the system', async () => {
    const { t, sellerId, a } = withSeller();
    const body = { mainActivityId: a, extraActivityIds: [], reason: 'x' };
    t.withhold();
    expect(await t.set.execute(adminOf(t, code), { sellerId, body })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await t.get.execute(adminOf(t, code), { sellerId })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect((await t.set.execute(sellerOf(t, code, sellerId), { sellerId, body })).ok).toBe(false);
    expect((await t.get.execute(sellerOf(t, code, sellerId), { sellerId })).ok).toBe(false);
    expect((await t.set.execute(testCallContext(market, 'system'), { sellerId, body })).ok).toBe(
      false,
    );
    expect(t.rows.held.size).toBe(0);
  });

  describe('sellerBusinessActivities (facade)', () => {
    async function assigned() {
      const s = withSeller();
      await s.t.set.execute(adminOf(s.t, code), {
        sellerId: s.sellerId,
        body: { mainActivityId: s.a, extraActivityIds: [s.b], reason: 'x' },
      });
      return s;
    }

    it('answers the system actor, with the main activity first', async () => {
      const { t, sellerId, a, b } = await assigned();
      const unassigned = t.ids.next<'Seller'>();
      const answer = await t.facade.sellerBusinessActivities(testCallContext(market, 'system'), [
        sellerId,
        unassigned,
        sellerId,
      ]);
      expect(answer).toEqual(
        ok(
          new Map([
            [sellerId, { mainActivityId: a, activityIds: [a, b] }],
            [unassigned, { mainActivityId: null, activityIds: [] }],
          ]),
        ),
      );
    });

    it("answers a seller's own account for its own id only", async () => {
      const { t, sellerId, a, b } = await assigned();
      const other = t.ids.next<'Seller'>();
      const own = sellerOf(t, code, sellerId);
      expect(await t.facade.sellerBusinessActivities(own, [sellerId])).toEqual(
        ok(new Map([[sellerId, { mainActivityId: a, activityIds: [a, b] }]])),
      );
      const foreign = await t.facade.sellerBusinessActivities(own, [sellerId, other]);
      expect(foreign).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await t.facade.sellerBusinessActivities(sellerOf(t, code, other), [sellerId])).toEqual(
        { ok: false, error: { code: 'access.denied' } },
      );
    });

    it('refuses an admin, an anonymous caller and a customer-less request actor', async () => {
      const { t, sellerId } = await assigned();
      expect((await t.facade.sellerBusinessActivities(adminOf(t, code), [sellerId])).ok).toBe(
        false,
      );
      expect(
        (await t.facade.sellerBusinessActivities(testCallContext(market, 'anonymous'), [sellerId]))
          .ok,
      ).toBe(false);
    });

    it('refuses more than 100 ids and a malformed id whole, before any read', async () => {
      const { t } = await assigned();
      const system = testCallContext(market, 'system');
      const many = Array.from({ length: 101 }, () => t.ids.next<'Seller'>());
      expect(await t.facade.sellerBusinessActivities(system, many)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] },
      });
      expect(
        await t.facade.sellerBusinessActivities(system, ['nope' as unknown as Id<'Seller'>]),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] },
      });
    });

    it("never answers another Market's rows", async () => {
      const { t, sellerId } = await assigned();
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const answer = await t.facade.sellerBusinessActivities(
        testCallContext(testMarketContext(other, 'default'), 'system'),
        [sellerId],
      );
      expect(answer).toEqual(ok(new Map([[sellerId, { mainActivityId: null, activityIds: [] }]])));
    });
  });
});

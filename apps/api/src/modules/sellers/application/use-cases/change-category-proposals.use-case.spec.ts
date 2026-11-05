import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
} from '@mondapac/shared-kernel';
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
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  CategoryProposalsSettingRepository,
  CategoryProposalsSettingState,
} from '../ports/category-proposals-setting.repository';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { MayProposeCategoriesSystem } from './may-propose-categories-system.use-case';
import { MayProposeCategories } from './may-propose-categories.use-case';
import { ChangeCategoryProposalsUseCase } from './change-category-proposals.use-case';

// The category-proposals switch of a seller (SEL-26; categories C9-0) in memory, on both Market
// fixtures. The PostgreSQL side is covered by test/db/seller-category-proposals.db-spec.ts.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class Rows implements CategoryProposalsSettingRepository {
  readonly rows = new Map<string, { allowed: boolean; version: number; by: string | null }>();

  seed(market: MarketContext, sellerId: Id<'Seller'>, allowed = false): void {
    this.rows.set(`${market.marketId}|${sellerId}`, { allowed, version: 1, by: null });
  }

  lock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<CategoryProposalsSettingState | null> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`);
    if (row === undefined) return Promise.resolve(null);
    row.version += 1;
    return Promise.resolve({ allowed: row.allowed, version: row.version });
  }

  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: { allowed: boolean; by: Id<'Account'> },
  ): Promise<void> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`)!;
    row.allowed = change.allowed;
    row.by = change.by;
    return Promise.resolve();
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const rows = new Rows();
  const audits: AuditEntry[] = [];
  const events: PendingEvent[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox: OutboxWriter = {
    append: (_context, appended) => {
      events.push(...appended);
      return Promise.resolve();
    },
  };
  let held = true;
  const checked: unknown[] = [];
  const authorisation: AuthorisationCheck = {
    check: (...args: unknown[]) => {
      checked.push(args);
      return Promise.resolve(
        held ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  let failRead = false;
  const sellingFacts = {
    categoryProposalsAllowed: (market: MarketContext, sellerId: Id<'Seller'>) =>
      failRead
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve(rows.rows.get(`${market.marketId}|${sellerId}`)?.allowed ?? null),
  } as unknown as SellingFactsRepository;
  return {
    clock,
    ids,
    rows,
    audits,
    events,
    checked,
    withhold: () => void (held = false),
    failRead: () => void (failRead = true),
    read: new MayProposeCategories(gate, { unitOfWork, sellingFacts }),
    readSystem: new MayProposeCategoriesSystem(gate, { unitOfWork, sellingFacts }),
    set: new ChangeCategoryProposalsUseCase(gate, {
      unitOfWork,
      categoryProposalsSetting: rows,
      audit,
      outbox,
      clock,
    }),
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

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each([['AU'], ['ZZ']])('category proposals switch (SEL-26) in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const anonymousIn = () => testCallContext(market, 'anonymous');

  it('is off for a new seller, on after an admin grants it, off again after a revoke', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const context = adminOf(t, code);
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(false));

    const on = await t.set.execute(context, { sellerId, body: { allowed: true } });
    expect(on).toEqual(ok({ allowed: true, changed: true }));
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(true));
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      ok(true),
    );

    const off = await t.set.execute(context, { sellerId, body: { allowed: false } });
    expect(off).toEqual(ok({ allowed: false, changed: true }));
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(false));

    expect(t.audits).toHaveLength(2);
    expect(t.audits[0]).toMatchObject({
      action: 'sellers.category-proposals.changed',
      targetId: sellerId,
      before: { enabled: false },
      after: { enabled: true },
    });
    expect(t.audits[1]).toMatchObject({
      action: 'sellers.category-proposals.changed',
      before: { enabled: true },
      after: { enabled: false },
    });
    expect(t.events.map((e) => [e.type, e.aggregateType, e.payload])).toEqual([
      ['sellers.category-proposals-granted.v1', 'seller-admin-settings', { sellerId }],
      ['sellers.category-proposals-revoked.v1', 'seller-admin-settings', { sellerId }],
    ]);
    expect(t.events[0]!.aggregateId).not.toBe(sellerId);
    expect(t.events[1]!.aggregateId).toBe(t.events[0]!.aggregateId);
    expect(t.events[1]!.aggregateVersion).toBeGreaterThan(t.events[0]!.aggregateVersion);
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.by).toBe(
      (context.actor as { accountId: string }).accountId,
    );
  });

  it('asks the gate for sellers.seller-settings.edit', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    await t.set.execute(adminOf(t, code), { sellerId, body: { allowed: true } });
    expect(JSON.stringify(t.checked)).toContain('sellers.seller-settings.edit');
  });

  it('writes nothing for a repeat of the same value', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body: { allowed: true } });
    expect(result).toEqual(ok({ allowed: true, changed: false }));
    expect(t.audits).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it.each([
    ['not an object', 'on', [{ path: '', code: 'type' }]],
    ['an array', [true], [{ path: '', code: 'type' }]],
    ['no allowed', {}, [{ path: 'allowed', code: 'required' }]],
    ['a non-boolean', { allowed: 'yes' }, [{ path: 'allowed', code: 'type' }]],
    [
      'an unknown field',
      { allowed: true, reason: 'x' },
      [{ path: 'reason', code: 'unknown-field' }],
    ],
  ])('refuses %s', async (_name, body, fields) => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body });
    expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
    expect(t.events).toEqual([]);
  });

  it('answers file.not-found for an unknown or malformed seller and unavailable to a reader', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const missing = await t.set.execute(adminOf(t, code), { sellerId, body: { allowed: true } });
    expect(missing).toEqual({ ok: false, error: { code: 'file.not-found' } });
    const malformed = await t.set.execute(adminOf(t, code), {
      sellerId: 'not-a-uuid',
      body: { allowed: true },
    });
    expect(malformed).toEqual({ ok: false, error: { code: 'file.not-found' } });
    const read = await t.read.execute(anonymousIn(), { sellerId });
    expect(read).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it("treats another Market's seller as unknown, for the change and the read", async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    t.rows.seed(other, sellerId, true);
    const change = await t.set.execute(adminOf(t, code), { sellerId, body: { allowed: false } });
    expect(change).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    expect(t.rows.rows.get(`${other.marketId}|${sellerId}`)?.allowed).toBe(true);
    expect(t.events).toEqual([]);
  });

  it('fails closed on a read error: never "allowed"', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    t.failRead();
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  it('is refused to an admin without the key, a seller and the system', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    t.withhold();
    const denied = await t.set.execute(adminOf(t, code), { sellerId, body: { allowed: true } });
    expect(denied).toEqual({ ok: false, error: { code: 'access.denied' } });
    const sellerContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    const bySeller = await t.set.execute(sellerContext, { sellerId, body: { allowed: true } });
    expect(bySeller.ok).toBe(false);
    const bySystem = await t.set.execute(testCallContext(market, 'system'), {
      sellerId,
      body: { allowed: true },
    });
    expect(bySystem.ok).toBe(false);
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.allowed).toBe(false);
    expect(t.audits).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('keeps the request reader away from the system actor and the system reader from requests', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    expect((await t.read.execute(testCallContext(market, 'system'), { sellerId })).ok).toBe(false);
    expect((await t.readSystem.execute(adminOf(t, code), { sellerId })).ok).toBe(false);
  });
});

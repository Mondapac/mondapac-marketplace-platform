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
import type { BlogAccessRepository, BlogAccessState } from '../ports/blog-access.repository';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { BlogAccessSystem } from './blog-access-system.use-case';
import { BlogAccessSetUseCase } from './blog-access-set.use-case';
import { BlogAccess } from './blog-access.use-case';

// The blog switch of a seller (blog package 1) in memory, on both Market fixtures. The PostgreSQL
// column and its CHECK are covered by test/db/blog-schema.db-spec.ts.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class Rows implements BlogAccessRepository {
  readonly rows = new Map<string, { enabled: boolean; version: number; by: string | null }>();

  seed(market: MarketContext, sellerId: Id<'Seller'>, enabled = false): void {
    this.rows.set(`${market.marketId}|${sellerId}`, { enabled, version: 1, by: null });
  }

  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<BlogAccessState | null> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`);
    if (row === undefined) return Promise.resolve(null);
    row.version += 1;
    return Promise.resolve({ enabled: row.enabled, version: row.version });
  }

  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: { enabled: boolean; by: Id<'Account'> },
  ): Promise<void> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`)!;
    row.enabled = change.enabled;
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
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        held ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const sellingFacts = {
    blogEnabled: (market: MarketContext, sellerId: Id<'Seller'>) =>
      Promise.resolve(rows.rows.get(`${market.marketId}|${sellerId}`)?.enabled ?? null),
  } as unknown as SellingFactsRepository;
  return {
    clock,
    ids,
    rows,
    audits,
    events,
    withhold: () => void (held = false),
    read: new BlogAccess(gate, { unitOfWork, sellingFacts }),
    readSystem: new BlogAccessSystem(gate, { unitOfWork, sellingFacts }),
    set: new BlogAccessSetUseCase(gate, { unitOfWork, blogAccess: rows, audit, outbox, clock }),
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

describe.each([['AU'], ['ZZ']])('blog access switch in %s', (code) => {
  const market = testMarketContext(code, 'default');

  it('is off for a new seller and on after an admin switches it on', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const context = adminOf(t, code);
    expect(await t.read.execute(testCallContext(market, 'anonymous'), { sellerId })).toEqual(
      ok(false),
    );

    const on = await t.set.execute(context, { sellerId, body: { enabled: true } });
    expect(on).toEqual(ok({ enabled: true, changed: true }));
    expect(await t.read.execute(testCallContext(market, 'anonymous'), { sellerId })).toEqual(
      ok(true),
    );
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      ok(true),
    );
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({
      action: 'sellers.blog-access.change',
      targetId: sellerId,
      before: { enabled: false },
      after: { enabled: true, unpublishLive: false },
    });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({
      type: 'sellers.blog-access-changed.v1',
      payload: { sellerId, enabled: true, unpublishLive: false },
    });
  });

  it('writes nothing for a repeat of the same value', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
    expect(result).toEqual(ok({ enabled: true, changed: false }));
    expect(t.audits).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('carries the optional unpublish of live posts on a switch-off, with a version per event', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    const context = adminOf(t, code);
    await t.set.execute(context, { sellerId, body: { enabled: false, unpublishLive: true } });
    await t.set.execute(context, { sellerId, body: { enabled: true } });
    expect(t.events.map((e) => e.payload)).toEqual([
      { sellerId, enabled: false, unpublishLive: true },
      { sellerId, enabled: true, unpublishLive: false },
    ]);
    expect(t.events[1]!.aggregateVersion).toBeGreaterThan(t.events[0]!.aggregateVersion);
  });

  it.each([
    ['not an object', 'on', [{ path: '', code: 'type' }]],
    ['no enabled', {}, [{ path: 'enabled', code: 'required' }]],
    ['a non-boolean', { enabled: 'yes' }, [{ path: 'enabled', code: 'type' }]],
    [
      'an unknown field',
      { enabled: true, reason: 'x' },
      [{ path: 'reason', code: 'unknown-field' }],
    ],
    [
      'unpublish while switching on',
      { enabled: true, unpublishLive: true },
      [{ path: 'unpublishLive', code: 'only-when-switching-off' }],
    ],
  ])('refuses %s', async (_name, body, fields) => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body });
    expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
  });

  it('answers file.not-found for an unknown seller and unavailable to a reader', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const missing = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
    expect(missing).toEqual({ ok: false, error: { code: 'file.not-found' } });
    const read = await t.read.execute(testCallContext(market, 'anonymous'), { sellerId });
    expect(read).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('is refused to an admin without sellers.blog-access.edit, a seller and the system', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    t.withhold();
    const denied = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
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
    const bySeller = await t.set.execute(sellerContext, { sellerId, body: { enabled: true } });
    expect(bySeller.ok).toBe(false);
    const bySystem = await t.set.execute(testCallContext(market, 'system'), {
      sellerId,
      body: { enabled: true },
    });
    expect(bySystem.ok).toBe(false);
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.enabled).toBe(false);
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

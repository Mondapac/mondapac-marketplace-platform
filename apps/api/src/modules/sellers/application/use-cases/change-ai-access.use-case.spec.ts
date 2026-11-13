import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
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
import type {
  AiAccessSettingRepository,
  AiAccessSettingState,
} from '../ports/ai-access-setting.repository';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { ViewAiAccessUseCase } from './view-ai-access.use-case';
import { AiAccessSystem } from './ai-access-system.use-case';
import { AiAccess } from './ai-access.use-case';
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import { ChangeAiAccessUseCase } from './change-ai-access.use-case';

// The category-proposals switch of a seller (SEL-25) in memory, on both Market
// fixtures. The PostgreSQL side is covered by test/db/seller-ai-access.db-spec.ts.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class Rows implements AiAccessSettingRepository {
  readonly rows = new Map<
    string,
    { enabled: boolean; version: number; by: string | null; at: Temporal.Instant | null }
  >();

  seed(market: MarketContext, sellerId: Id<'Seller'>, enabled = false): void {
    this.rows.set(`${market.marketId}|${sellerId}`, { enabled, version: 1, by: null, at: null });
  }

  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<AiAccessSettingState | null> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`);
    if (row === undefined) return Promise.resolve(null);
    row.version += 1;
    return Promise.resolve({ enabled: row.enabled, version: row.version });
  }

  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: { enabled: boolean; by: Id<'Account'>; at: Temporal.Instant },
  ): Promise<void> {
    const row = this.rows.get(`${market.marketId}|${sellerId}`)!;
    row.enabled = change.enabled;
    row.by = change.by;
    row.at = change.at;
    return Promise.resolve();
  }

  read(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = this.rows.get(`${market.marketId}|${sellerId}`);
    return Promise.resolve(row === undefined ? null : { enabled: row.enabled, changedAt: row.at });
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
  let readFails: 'throw' | 'unit-err' | null = null;
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
  const unitOfWork: UnitOfWork = {
    run: ((_market: unknown, work: () => Promise<unknown>, options?: { readOnly?: boolean }) =>
      readFails === 'unit-err' && options?.readOnly === true
        ? Promise.resolve({ ok: false, error: { code: 'unit.failed' } })
        : work()) as UnitOfWork['run'],
    runOnce: noRunOnce,
  };
  const sellingFacts = {
    aiEnabled: (market: MarketContext, sellerId: Id<'Seller'>) =>
      readFails === 'throw'
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve(rows.rows.get(`${market.marketId}|${sellerId}`)?.enabled ?? null),
  } as unknown as SellingFactsRepository;
  return {
    clock,
    ids,
    rows,
    audits,
    checked,
    withhold: () => void (held = false),
    failRead: (how: 'throw' | 'unit-err' = 'throw') => void (readFails = how),
    read: new AiAccess(gate, { unitOfWork, sellingFacts }),
    readSystem: new AiAccessSystem(gate, { unitOfWork, sellingFacts }),
    view: new ViewAiAccessUseCase(gate, { unitOfWork, aiAccessSetting: rows }),
    set: new ChangeAiAccessUseCase(gate, {
      unitOfWork,
      aiAccessSetting: rows,
      audit,
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

describe.each([['AU'], ['ZZ']])('AI switch (SEL-25) in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const anonymousIn = () => testCallContext(market, 'anonymous');

  it('is off for a new seller, on after an admin grants it, off again after a revoke', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const context = adminOf(t, code);
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(false));

    const on = await t.set.execute(context, { sellerId, body: { enabled: true } });
    expect(on).toEqual(ok({ enabled: true, changed: true }));
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(true));
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      ok(true),
    );

    const off = await t.set.execute(context, { sellerId, body: { enabled: false } });
    expect(off).toEqual(ok({ enabled: false, changed: true }));
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual(ok(false));

    expect(t.audits).toHaveLength(2);
    expect(t.audits[0]).toMatchObject({
      action: 'sellers.ai-access.changed',
      targetId: sellerId,
      before: { enabled: false },
      after: { enabled: true },
    });
    expect(t.audits[1]).toMatchObject({
      action: 'sellers.ai-access.changed',
      before: { enabled: true },
      after: { enabled: false },
    });
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.by).toBe(
      (context.actor as { accountId: string }).accountId,
    );
  });

  it('asks the gate for sellers.seller-settings.edit', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
    expect(JSON.stringify(t.checked)).toContain('sellers.seller-settings.edit');
  });

  it('writes nothing for a repeat of the same value', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
    expect(result).toEqual(ok({ enabled: true, changed: false }));
    expect(t.audits).toEqual([]);
  });

  it.each([
    ['not an object', 'on', [{ path: '', code: 'type' }]],
    ['an array', [true], [{ path: '', code: 'type' }]],
    ['no enabled', {}, [{ path: 'enabled', code: 'required' }]],
    ['a non-boolean', { enabled: 'yes' }, [{ path: 'enabled', code: 'type' }]],
    [
      'an unknown field',
      { enabled: true, reason: 'x' },
      [{ path: 'reason', code: 'unknown-field' }],
    ],
  ])('refuses %s', async (_name, body, fields) => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const result = await t.set.execute(adminOf(t, code), { sellerId, body });
    expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
  });

  it('answers file.not-found for an unknown or malformed seller and unavailable to a reader', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const missing = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: true } });
    expect(missing).toEqual({ ok: false, error: { code: 'file.not-found' } });
    const malformed = await t.set.execute(adminOf(t, code), {
      sellerId: 'not-a-uuid',
      body: { enabled: true },
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
    const change = await t.set.execute(adminOf(t, code), { sellerId, body: { enabled: false } });
    expect(change).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    expect(t.rows.rows.get(`${other.marketId}|${sellerId}`)?.enabled).toBe(true);
  });

  it.each([['throw'], ['unit-err']] as const)(
    'fails closed on a read error (%s): never "enabled"',
    async (how) => {
      const t = setUp();
      const sellerId = t.ids.next<'Seller'>();
      t.rows.seed(market, sellerId, true);
      t.failRead(how);
      expect(await t.read.execute(anonymousIn(), { sellerId })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
      expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    },
  );

  it('is refused to an admin without the key, a seller and the system', async () => {
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
    expect(t.audits).toEqual([]);
  });

  it('refuses a seller in the handler even when the gate lets the call through', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const sellerContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    const result = await t.set.execute(sellerContext, { sellerId, body: { enabled: true } });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(t.checked.length).toBeGreaterThan(0);
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.enabled).toBe(false);
  });

  it('refuses an acting-as session and changes nothing (ADR-0019 R3)', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const base = adminOf(t, code);
    const actingAs = {
      ...base,
      actor: { ...base.actor, actingAs: { adminAccountId: t.ids.next<'Account'>() } },
    } as unknown as CallContext;
    const result = await t.set.execute(actingAs, { sellerId, body: { enabled: true } });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(t.rows.rows.get(`${code}|${sellerId}`)?.enabled).toBe(false);
    expect(t.audits).toEqual([]);
  });

  it('is routed by the facade: the system actor to the system case, a request to the anonymous one', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId, true);
    const calls: string[] = [];
    const spy = (name: string, useCase: { execute: (...args: never[]) => unknown }) =>
      ({
        execute: (...args: never[]) => {
          calls.push(name);
          return useCase.execute(...args);
        },
      }) as never;
    const facade = new SellersFacadeImplementation({
      aiAccess: spy('request', t.read),
      aiAccessSystem: spy('system', t.readSystem),
    } as unknown as ConstructorParameters<typeof SellersFacadeImplementation>[0]);
    expect(await facade.aiAccessOf(testCallContext(market, 'system'), sellerId)).toEqual(ok(true));
    expect(await facade.aiAccessOf(anonymousIn(), sellerId)).toEqual(ok(true));
    expect(await facade.aiAccessOf(adminOf(t, code), sellerId)).toEqual(ok(true));
    expect(calls).toEqual(['system', 'request', 'request']);
  });

  it('keeps the request reader away from the system actor and the system reader from requests', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    expect((await t.read.execute(testCallContext(market, 'system'), { sellerId })).ok).toBe(false);
    expect((await t.readSystem.execute(adminOf(t, code), { sellerId })).ok).toBe(false);
  });

  it('shows the switch and when it changed to an admin with the view key', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const context = adminOf(t, code);
    expect(await t.view.execute(context, { sellerId })).toEqual(
      ok({ enabled: false, changedAt: null }),
    );
    await t.set.execute(context, { sellerId, body: { enabled: true } });
    expect(await t.view.execute(context, { sellerId })).toEqual(
      ok({ enabled: true, changedAt: START }),
    );
    expect(JSON.stringify(t.checked)).toContain('sellers.seller.view');
  });

  it('answers file.not-found to the view for an unknown, malformed or other-Market seller', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    t.rows.seed(other, sellerId, true);
    const notFound = { ok: false, error: { code: 'file.not-found' } };
    expect(await t.view.execute(adminOf(t, code), { sellerId })).toEqual(notFound);
    expect(await t.view.execute(adminOf(t, code), { sellerId: 'nope' })).toEqual(notFound);
  });

  it('refuses the view to an admin without the key and to a seller', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.rows.seed(market, sellerId);
    const sellerContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    expect(await t.view.execute(sellerContext, { sellerId })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    t.withhold();
    expect((await t.view.execute(adminOf(t, code), { sellerId })).ok).toBe(false);
  });
});

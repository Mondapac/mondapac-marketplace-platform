import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { ActiveSinceSystem } from './active-since-system.use-case';
import { ActiveSince } from './active-since.use-case';

// `activeSinceOf` (promotions T1) in memory, on both Market fixtures. The query on
// `business_file_revisions` is PrismaSellingFactsRepository.firstApprovedAt.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const APPROVED = Temporal.Instant.from('2026-09-01T03:15:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

function setUp() {
  const ids = new SequenceIdGenerator(new FixedClock(START));
  const approvals = new Map<string, Temporal.Instant>();
  const readOnly: boolean[] = [];
  let failing = false;
  const unitOfWork: UnitOfWork = {
    run: (_market, work, options) => {
      readOnly.push(options?.readOnly === true);
      return work();
    },
    runOnce: noRunOnce,
  };
  const sellingFacts = {
    firstApprovedAt: (market: MarketContext, sellerId: Id<'Seller'>) =>
      failing
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve(approvals.get(`${market.marketId}|${sellerId}`) ?? null),
  } as unknown as SellingFactsRepository;
  const authorisation: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
  const gate = createUseCaseGate(markets, authorisation);
  return {
    ids,
    approvals,
    readOnly,
    fail: () => void (failing = true),
    read: new ActiveSince(gate, { unitOfWork, sellingFacts }),
    readSystem: new ActiveSinceSystem(gate, { unitOfWork, sellingFacts }),
  };
}
type Setup = ReturnType<typeof setUp>;

const sellerOf = (t: Setup, market: MarketContext, sellerId: Id<'Seller'>): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each([['AU'], ['ZZ']])('active since in %s', (code) => {
  const market = testMarketContext(code, 'default');

  it('answers the first approval instant to a request actor and to the system actor', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.approvals.set(`${market.marketId}|${sellerId}`, APPROVED);
    expect(await t.read.execute(sellerOf(t, market, sellerId), { sellerId })).toEqual(ok(APPROVED));
    expect(await t.read.execute(testCallContext(market, 'anonymous'), { sellerId })).toEqual(
      ok(APPROVED),
    );
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      ok(APPROVED),
    );
    expect(t.readOnly).toEqual([true, true, true]);
  });

  it('answers null for a seller never approved and for an unknown seller alike', async () => {
    const t = setUp();
    const never = t.ids.next<'Seller'>();
    const unknown = t.ids.next<'Seller'>();
    const context = testCallContext(market, 'system');
    const a = await t.readSystem.execute(context, { sellerId: never });
    const b = await t.readSystem.execute(context, { sellerId: unknown });
    expect(a).toEqual(ok(null));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("never answers another Market's approval", async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    t.approvals.set(`${other}|${sellerId}`, APPROVED);
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      ok(null),
    );
  });

  it('refuses a malformed id before any read', async () => {
    const t = setUp();
    const result = await t.read.execute(testCallContext(market, 'anonymous'), {
      sellerId: 'not-an-id',
    });
    expect(result).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] }),
    );
    expect(t.readOnly).toEqual([]);
  });

  it('answers sellers.unavailable when the read fails, never an instant', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.approvals.set(`${market.marketId}|${sellerId}`, APPROVED);
    t.fail();
    expect(await t.readSystem.execute(testCallContext(market, 'system'), { sellerId })).toEqual(
      err({ code: 'sellers.unavailable' }),
    );
  });

  it('keeps the pair apart: the system case refuses a request actor', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const result = await t.readSystem.execute(testCallContext(market, 'anonymous'), { sellerId });
    expect(result.ok).toBe(false);
  });

  it('is reached through the facade, the pair chosen by the actor', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.approvals.set(`${market.marketId}|${sellerId}`, APPROVED);
    const facade = new SellersFacadeImplementation({
      activeSince: t.read,
      activeSinceSystem: t.readSystem,
    } as unknown as ConstructorParameters<typeof SellersFacadeImplementation>[0]);
    expect(await facade.activeSinceOf(testCallContext(market, 'system'), sellerId)).toEqual(
      ok(APPROVED),
    );
    expect(await facade.activeSinceOf(sellerOf(t, market, sellerId), sellerId)).toEqual(
      ok(APPROVED),
    );
  });
});

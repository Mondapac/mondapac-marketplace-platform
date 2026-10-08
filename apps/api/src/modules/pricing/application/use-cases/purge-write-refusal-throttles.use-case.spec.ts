import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeUnitOfWork,
  InMemoryRefusalThrottles,
} from '../../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  PurgeWriteRefusalThrottles,
  REFUSAL_COUNTERS_KEPT_MS,
} from './purge-write-refusal-throttles.use-case';

// The hourly purge of the refusal counters (pricing-data 3.8, 9), on both Market fixtures:
// system actor only; one unit per table, the actor table first (the lock order of part 3b);
// only this Market's counters older than an hour go.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(['AU', 'ZZ'])('pricing.purge-write-refusal-throttles in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const now = Temporal.Instant.from('2026-10-08T10:00:00Z');

  function setup() {
    const clock = new FixedClock(now);
    const ids = new SequenceIdGenerator(clock);
    const unitOfWork = new FakeUnitOfWork();
    const throttles = new InMemoryRefusalThrottles();
    const purge = new PurgeWriteRefusalThrottles(gate, { unitOfWork, throttles, clock });
    return { ids, unitOfWork, throttles, purge };
  }

  it('purges counters older than an hour, actor table first, each in its own unit', async () => {
    const t = setup();
    const old = now.subtract({ milliseconds: REFUSAL_COUNTERS_KEPT_MS + 1 });
    const kept = now.subtract({ milliseconds: REFUSAL_COUNTERS_KEPT_MS });
    for (const [target, at] of [
      [market, old],
      [market, kept],
      [other, old],
    ] as const) {
      await t.throttles.admitRefusal(target, t.ids.next(), t.ids.next(), at, 60_000, 20);
    }
    t.throttles.touched.length = 0;

    const result = await t.purge.execute(testCallContext(market, 'system'), {});
    expect(result).toEqual({ ok: true, value: { actorWindows: 1, offerWindows: 1 } });
    expect(t.throttles.touched).toEqual(['purge-actor', 'purge-offer']);
    expect(t.unitOfWork.units).toEqual([
      { market: market.marketId, options: {} },
      { market: market.marketId, options: {} },
    ]);
    expect(t.throttles.actors.size).toBe(2);
  });

  it('runs for the system actor only', async () => {
    const t = setup();
    const seller = testAuthenticatedActor(market, {
      population: 'seller',
      accountId: t.ids.next(),
      sessionId: t.ids.next(),
      sellerId: t.ids.next(),
    });
    expect((await t.purge.execute(testCallContext(market, seller), {})).ok).toBe(false);
    expect(t.unitOfWork.units).toEqual([]);
  });
});

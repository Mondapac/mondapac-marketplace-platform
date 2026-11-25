import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SearchShoppersRequest } from '../contracts';
import { MAX_SEARCH_KEYS, MIN_SEARCH_SHOPPERS } from '../domain/search-shoppers';
import type { EngagementDependencies } from './engagement-dependencies';
import {
  FakeEngagementGuestTokens,
  FakePublishedStores,
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
  InMemoryStoreFollows,
  RecordingEngagementOutbox,
} from './testing/in-memory-engagement';
import { CountSearchShoppers } from './use-cases/count-search-shoppers.use-case';
import { RecordEvent } from './use-cases/record-event.use-case';
import { RecordGuestEvent } from './use-cases/record-guest-event.use-case';
import { SetPersonalization } from './use-cases/set-personalization.use-case';

// The zero-result searchers' counts (dashboards v2, phase 2) on both Market fixtures, whose zones are
// not UTC: only asked texts, only signed-in accounts with personalization on, at least ten distinct
// ones, the window is the caller's Market day, nothing crosses Markets, and only the system actor
// is answered. Ids are never returned.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const searched = (query: string) => ({ kind: 'search-performed', query });
const quiet = { globalPrivacyControl: false };
const accounts = (count: number, from = 0xa00) =>
  Array.from({ length: count }, (_, n) => id<'Account'>(from + n));

describe.each([['AU'], ['ZZ']] as const)('the zero-result searchers in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const zone = markets.get(market.marketId).timezone;
  const dayStart = Temporal.PlainDate.from('2026-11-24').toZonedDateTime({ timeZone: zone });
  const window = { from: dayStart.toInstant(), to: dayStart.add({ days: 1 }).toInstant() };
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system');
  const customer = (accountId: Id<'Account'>, target = market) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'search-abcd',
    );
  let clock: FixedClock;
  let deps: EngagementDependencies;
  let count: CountSearchShoppers;
  const noon = dayStart.add({ hours: 12 }).toInstant();

  const at = async (
    instant: Temporal.Instant,
    accountId: Id<'Account'>,
    query: string,
    target = market,
  ) => {
    clock.set(instant);
    const out = await new RecordEvent(gate, deps).execute(customer(accountId, target), {
      event: searched(query),
      ...quiet,
    });
    expect(out).toEqual({ ok: true, value: { recorded: true } });
  };
  const ask = (request: Partial<SearchShoppersRequest> = {}) =>
    count.execute(system, { window, queries: ['sangak bread', 'barberry'], ...request });

  beforeEach(() => {
    clock = new FixedClock(noon);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      events: new InMemoryBehaviourEvents(),
      settings: new InMemoryPersonalizationSettings(),
      guestTokens: new FakeEngagementGuestTokens(),
      follows: new InMemoryStoreFollows(),
      stores: new FakePublishedStores(),
      outbox: new RecordingEngagementOutbox(),
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    count = new CountSearchShoppers(gate, deps);
  });

  it('answers an asked text searched by ten distinct accounts, in any case, with counts only', async () => {
    const ten = accounts(MIN_SEARCH_SHOPPERS);
    for (const account of ten) await at(noon, account, 'Sangak Bread');
    await at(noon, ten[0]!, 'sangak bread'); // the same account again: one searcher, two searches
    const out = await ask();
    expect(out).toEqual({
      ok: true,
      value: [{ query: 'sangak bread', shoppers: MIN_SEARCH_SHOPPERS, searches: 11 }],
    });
    expect(JSON.stringify(out)).not.toContain(ten[0]!);
  });

  it('answers nothing for nine searchers, nor for a text that was not asked', async () => {
    for (const account of accounts(MIN_SEARCH_SHOPPERS - 1)) await at(noon, account, 'barberry');
    for (const account of accounts(MIN_SEARCH_SHOPPERS, 0xb00)) await at(noon, account, 'sumac');
    expect(await ask()).toEqual({ ok: true, value: [] });
  });

  it('never counts a guest, an account of another Market, one that switched personalization off, or another day', async () => {
    const nine = accounts(MIN_SEARCH_SHOPPERS - 1);
    for (const account of nine) await at(noon, account, 'barberry');
    const optedOut = id<'Account'>(0xc01);
    await at(noon, optedOut, 'barberry');
    await at(noon, id<'Account'>(0xc02), 'barberry', other);
    await at(window.to, id<'Account'>(0xc03), 'barberry');
    await at(window.from.subtract({ milliseconds: 1 }), id<'Account'>(0xc04), 'barberry');
    const guest = await new RecordGuestEvent(gate, deps).execute(
      testCallContext(market, 'anonymous'),
      { event: searched('barberry'), consent: true, token: null, ...quiet },
    );
    expect(guest).toMatchObject({ ok: true, value: { recorded: true } });
    const off = await new SetPersonalization(gate, deps).execute(customer(optedOut), {
      enabled: false,
    });
    expect(off.ok).toBe(true);
    expect(await ask()).toEqual({ ok: true, value: [] });
    // The tenth account on the day makes it count.
    await at(window.from, id<'Account'>(0xc05), 'barberry');
    expect(await ask()).toEqual({
      ok: true,
      value: [{ query: 'barberry', shoppers: MIN_SEARCH_SHOPPERS, searches: MIN_SEARCH_SHOPPERS }],
    });
  });

  it('refuses a malformed request whole and every actor but the system', async () => {
    const bad: Partial<SearchShoppersRequest>[] = [
      { window: { from: window.to, to: window.from } },
      { window: { from: window.from, to: window.from.add({ hours: 27 }) } },
      { queries: [''] },
      { queries: ['x'.repeat(201)] },
      { queries: [42 as unknown as string] },
      { queries: Array.from({ length: MAX_SEARCH_KEYS + 1 }, (_, n) => `q${n}`) },
    ];
    for (const request of bad) {
      expect(await ask(request)).toEqual({ ok: false, error: { code: 'validation.failed' } });
    }
    const out = await count.execute(customer(id<'Account'>(0xa1)), {
      window,
      queries: ['barberry'],
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'access.denied' } });
  });
});

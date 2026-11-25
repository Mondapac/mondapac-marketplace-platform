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
import type { ShoppingFunnelRequest } from '../contracts';
import { MAX_FUNNEL_CHECKOUTS } from '../domain/shopping-funnel';
import type { EngagementDependencies } from './engagement-dependencies';
import {
  FakeEngagementGuestTokens,
  FakePublishedStores,
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
  InMemoryStoreFollows,
  RecordingEngagementOutbox,
} from './testing/in-memory-engagement';
import { CountShoppingFunnel } from './use-cases/count-shopping-funnel.use-case';
import { RecordEvent } from './use-cases/record-event.use-case';
import { RecordGuestEvent } from './use-cases/record-guest-event.use-case';
import { SetPersonalization } from './use-cases/set-personalization.use-case';

// The shopping funnel's counts (dashboards v2, phase 2) on both Market fixtures, whose zones are
// not UTC: the window is the caller's Market day, guests never count, an account that switched
// personalization off is out of the population, nothing crosses Markets, and only the system
// actor is answered.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PRODUCT = id<'Product'>(0x101);
const OFFER = id<'Offer'>(0x201);
const VARIANT = id<'Variant'>(0x301);
const viewed = { kind: 'product-viewed', productId: PRODUCT, offerId: OFFER };
const carted = { kind: 'added-to-cart', offerId: OFFER, variantId: VARIANT };
const quiet = { globalPrivacyControl: false };

describe.each([['AU'], ['ZZ']] as const)('the shopping funnel counts in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const zone = markets.get(market.marketId).timezone;
  // The Market day 2026-11-24 in the Market's zone, never the UTC day.
  const dayStart = Temporal.PlainDate.from('2026-11-24').toZonedDateTime({ timeZone: zone });
  const window = {
    from: dayStart.toInstant(),
    to: dayStart.add({ days: 1 }).toInstant(),
  };
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
      'funnel-abcd',
    );
  let clock: FixedClock;
  let deps: EngagementDependencies;
  let count: CountShoppingFunnel;

  const at = async (
    instant: Temporal.Instant,
    accountId: Id<'Account'>,
    event: Record<string, unknown>,
    target = market,
  ) => {
    clock.set(instant);
    const out = await new RecordEvent(gate, deps).execute(customer(accountId, target), {
      event,
      ...quiet,
    });
    expect(out).toEqual({ ok: true, value: { recorded: true } });
  };
  const noon = dayStart.add({ hours: 12 }).toInstant();
  const ask = (request: Partial<ShoppingFunnelRequest> = {}) =>
    count.execute(system, { window, checkouts: [], ...request });

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
    count = new CountShoppingFunnel(gate, deps);
  });

  it('counts distinct accounts per step of the Market day, each within the step before', async () => {
    const [a, b, c, d] = [
      id<'Account'>(0xa1),
      id<'Account'>(0xa2),
      id<'Account'>(0xa3),
      id<'Account'>(0xa4),
    ];
    for (const account of [a, b, c, d]) await at(noon, account, viewed);
    await at(noon, a, viewed); // a second view counts once
    for (const account of [a, b, c]) await at(noon, account, carted);
    const out = await ask({
      checkouts: [
        { accountId: a, paid: true },
        { accountId: b, paid: false },
        { accountId: d, paid: true }, // no cart addition that day
      ],
    });
    expect(out).toEqual({ ok: true, value: { viewed: 4, carted: 3, checkedOut: 2, paid: 1 } });
  });

  it('keeps to the Market day: an event just before its start or at its end is another day', async () => {
    const a = id<'Account'>(0xa1);
    const b = id<'Account'>(0xa2);
    await at(window.from, a, viewed);
    await at(window.from.subtract({ milliseconds: 1 }), b, viewed);
    await at(window.to, b, viewed);
    expect(await ask()).toEqual({
      ok: true,
      value: { viewed: 1, carted: 0, checkedOut: 0, paid: 0 },
    });
  });

  it('never counts a guest, an account of another Market, or one that switched personalization off', async () => {
    const a = id<'Account'>(0xa1);
    const optedOut = id<'Account'>(0xa2);
    await at(noon, a, viewed);
    await at(noon, optedOut, viewed);
    await at(noon, optedOut, carted);
    await at(noon, id<'Account'>(0xa3), viewed, other);
    const guest = await new RecordGuestEvent(gate, deps).execute(
      testCallContext(market, 'anonymous'),
      {
        event: viewed,
        consent: true,
        token: null,
        ...quiet,
      },
    );
    expect(guest).toMatchObject({ ok: true, value: { recorded: true } });
    const off = await new SetPersonalization(gate, deps).execute(customer(optedOut), {
      enabled: false,
    });
    expect(off.ok).toBe(true);
    expect(await ask({ checkouts: [{ accountId: optedOut, paid: true }] })).toEqual({
      ok: true,
      value: { viewed: 1, carted: 0, checkedOut: 0, paid: 0 },
    });
  });

  it('refuses a malformed request whole and every actor but the system', async () => {
    const bad: Partial<ShoppingFunnelRequest>[] = [
      { window: { from: window.to, to: window.from } },
      { window: { from: window.from, to: window.from.add({ hours: 27 }) } },
      { checkouts: [{ accountId: 'nope' as Id<'Account'>, paid: true }] },
      { checkouts: [{ accountId: id<'Account'>(1), paid: 'yes' as unknown as boolean }] },
      {
        checkouts: Array.from({ length: MAX_FUNNEL_CHECKOUTS + 1 }, (_, n) => ({
          accountId: id<'Account'>(n + 1),
          paid: false,
        })),
      },
    ];
    for (const request of bad) {
      expect(await ask(request)).toEqual({ ok: false, error: { code: 'validation.failed' } });
    }
    const out = await count.execute(customer(id<'Account'>(0xa1)), { window, checkouts: [] });
    expect(out).toMatchObject({ ok: false, error: { code: 'access.denied' } });
  });
});

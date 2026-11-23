import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { MemoryDeliveryQuotes } from '../../../../../test/support/shipping-fakes';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigShippingPolicy } from '../../infrastructure/config-shipping-policy';
import type { PickupDirectory } from '../ports/pickup-directory';
import type { ShippingDependencies } from '../shipping-dependencies';
import { DeliveryRegionsQuery } from './delivery-regions.use-case';

// `shipping.delivery-regions` (dashboards v2, phase 1): the region of a charged quote's drop-off and
// of a seller's pickup, mapped in shipping with the Market's `shipping.postcodeRegions`, so only a
// region code reaches reporting. Both Market fixtures; system actor only; the request is bounded.

const id = <T extends string>(n: number) =>
  `0193a000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<T>;
const T0 = Temporal.Instant.from('2026-11-20T02:00:00Z');

/** Per Market: a postcode of each region used here, one in no range, and the expected codes. */
const FIXTURES = {
  AU: { north: ['4000', 'QLD'], south: ['3000', 'VIC'], none: '0100', currency: 'AUD' },
  ZZ: { north: ['1000000', 'ZA'], south: ['6000000', 'ZB'], none: '12', currency: 'JPY' },
} as const;

describe.each(TEST_MARKETS)('shipping delivery regions in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');
  const fixture = FIXTURES[code];
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

  const setup = (pickups: Partial<PickupDirectory> = {}) => {
    const quotes = new MemoryDeliveryQuotes();
    const unitOfWork = {
      run: (_market: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as UnitOfWork;
    const deps = {
      unitOfWork,
      quotes,
      policy: new ConfigShippingPolicy(markets, undefined as never),
      pickups: {
        postcodesOf: () =>
          Promise.resolve(
            ok(
              new Map([
                [id<'Seller'>(1), fixture.south[0]],
                [id<'Seller'>(2), fixture.none],
              ]),
            ),
          ),
        ...pickups,
      },
    } as unknown as ShippingDependencies;
    const quote = (n: number, postcode: string) =>
      quotes.insert(market, {
        id: id<'DeliveryQuote'>(n),
        accountId: id<'Account'>(9),
        sellerId: id<'Seller'>(1),
        method: 'same_day',
        dropoffPostcode: postcode,
        fleet: 'fake_test',
        quote: money(500n, fixture.currency),
        margin: money(100n, fixture.currency),
        total: money(600n, fixture.currency),
        etaMinutes: null,
        quotedAt: T0,
        fleetExpiresAt: null,
        validUntil: T0.add({ minutes: 10 }),
      });
    return { query: new DeliveryRegionsQuery(openGate(), deps), quote, quotes };
  };

  it('answers the region of each quote and pickup, leaving an unknown one out', async () => {
    const { query, quote } = setup();
    await quote(1, fixture.north[0]);
    await quote(2, fixture.none);
    const answer = await query.execute(system, {
      // Quote 3 was never stored (or was removed with the buyer's expired quotes).
      quoteIds: [id(1), id(2), id(3), id(1)],
      pickupSellerIds: [id(1), id(2), id(3)],
    });
    expect(answer).toEqual(
      ok({
        quotes: new Map([[id(1), fixture.north[1]]]),
        pickups: new Map([[id<'Seller'>(1), fixture.south[1]]]),
      }),
    );
    // Region codes only: no postcode anywhere in the answer.
    const text = JSON.stringify(answer.ok && [...answer.value.quotes, ...answer.value.pickups]);
    expect(text).not.toContain(fixture.north[0]);
    expect(text).not.toContain(fixture.south[0]);
  });

  it('reads nothing for an empty request and refuses a malformed or oversized one', async () => {
    const { query } = setup({ postcodesOf: () => Promise.reject(new Error('not expected')) });
    expect(await query.execute(system, { quoteIds: [], pickupSellerIds: [] })).toEqual(
      ok({ quotes: new Map(), pickups: new Map() }),
    );
    for (const input of [
      { quoteIds: ['not-an-id'], pickupSellerIds: [] },
      { quoteIds: [], pickupSellerIds: null },
      { quoteIds: Array.from({ length: 101 }, (_, n) => id(n + 1)), pickupSellerIds: [] },
    ]) {
      expect(await query.execute(system, input as never)).toEqual(
        err({ code: 'validation.failed' }),
      );
    }
  });

  it('fails closed when the sellers read fails, and admits only the system actor', async () => {
    const { query } = setup({
      postcodesOf: () => Promise.resolve(err({ code: 'pickup.unavailable' as const })),
    });
    expect(await query.execute(system, { quoteIds: [], pickupSellerIds: [id(1)] })).toEqual(
      err({ code: 'shipping.unavailable' }),
    );
    await expectSystemOnly(code, (context) =>
      query.execute(context, { quoteIds: [], pickupSellerIds: [] }),
    );
  });
});

import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { SellersFacade } from '../../sellers';
import { FacadeSellerZones, SellerZoneUnavailableError } from './facade-seller-zones';
import { RegistryMarketZones } from './prisma-ship-to-retention.repository';

// The seller's zone for the seller tasks' local day (dashboards upgrade, phase 1, PR 6), on both
// Market fixtures (each with its own Market zone): the seller's approved operating zone from
// sellers, asked for the session's seller with the caller's context unchanged; the Market's zone
// when sellers has none for it; and a refusal or a failure of sellers is an error, never a guess.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0xa3);
const SELLER_ZONE = 'Pacific/Auckland';

type Answer = Awaited<ReturnType<SellersFacade['operatingZones']>>;

describe('the Market fixtures', () => {
  it('have different Market zones, so a fallback to the wrong Market would show', () => {
    const zones = new RegistryMarketZones(markets);
    const [first, second] = TEST_MARKETS.map((code) =>
      zones.zoneOf(testMarketContext(code, PLATFORM_TENANT_ID)),
    );
    expect(first).not.toBe(second);
  });
});

describe.each(TEST_MARKETS)('FacadeSellerZones in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketZone = markets.get(market.marketId).timezone;
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id(0xa1),
      sessionId: id(0xa2),
      sellerId: SELLER,
    }),
  );
  let calls: { context: CallContext; sellerIds: readonly Id<'Seller'>[] }[];
  let answer: Answer;
  const sellers: Pick<SellersFacade, 'operatingZones'> = {
    operatingZones: (callContext, sellerIds) => {
      calls.push({ context: callContext, sellerIds });
      return Promise.resolve(answer);
    },
  };
  const zones = new FacadeSellerZones(sellers, new RegistryMarketZones(markets));

  beforeEach(() => {
    calls = [];
    answer = ok(new Map([[SELLER, SELLER_ZONE]]));
  });

  it("reads the session seller's zone with the caller's context unchanged", async () => {
    expect(await zones.zoneOf(context, SELLER)).toBe(SELLER_ZONE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toBe(context);
    expect(calls[0]!.sellerIds).toEqual([SELLER]);
  });

  it("falls back to the Market's zone when the seller has no operating zone", async () => {
    answer = ok(new Map([[id<'Seller'>(0xb3), SELLER_ZONE]]));
    expect(await zones.zoneOf(context, SELLER)).toBe(marketZone);
    answer = ok(new Map());
    expect(await zones.zoneOf(context, SELLER)).toBe(marketZone);
  });

  it.each([
    ['denied', { code: 'access.denied' as const }],
    ['unavailable', { code: 'sellers.unavailable' as const }],
  ])('throws SellerZoneUnavailableError when sellers answers %s', async (_label, refusal) => {
    answer = err(refusal);
    await expect(zones.zoneOf(context, SELLER)).rejects.toBeInstanceOf(SellerZoneUnavailableError);
  });
});

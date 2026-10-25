import { ok } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import { ConfigShippingPolicy } from '../infrastructure/config-shipping-policy';
import type { ShippingDependencies } from './shipping-dependencies';
import { DeliveryArea } from './use-cases/delivery-area.use-case';

// The delivery area check on both Market fixtures (AU in AUD, ZZ in JPY). The delivery prices have
// their own specs (the quote, charge and fee ledger use cases).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');

describe.each([['AU'], ['ZZ']] as const)('shipping delivery area in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const deps = {
    unitOfWork: new FakeUnitOfWork(),
    policy: new ConfigShippingPolicy(markets, areas),
    clock,
  } as unknown as ShippingDependencies;

  it('answers whether the Market delivers to a postcode, for anyone, fail closed', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'ship-anon-abcd');
    const ask = (postcode: unknown) =>
      new DeliveryArea(gate, deps).execute(anonymous, { postcode });
    // AU's only area is listed but not open for delivery until the owner opens it; ZZ has two
    // open areas with seven-digit and letter postcodes.
    const inside = code === 'AU' ? '4031' : ' zz1 9aa ';
    expect(await ask(inside)).toEqual(ok({ delivers: code === 'ZZ' }));
    expect(await ask(code === 'AU' ? '2000' : '3000000')).toEqual(ok({ delivers: false }));
    for (const bad of ['', '   ', 'x'.repeat(17), 'ä', 4031, null, undefined]) {
      expect(await ask(bad)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
  });

  it('reads the fallback cap and the quote bounds from the Market shipping settings', () => {
    const policy = new ConfigShippingPolicy(markets, areas);
    // AU absorbs up to A$10.00 of a dearer fallback fleet, the ZZ fixture up to 500 yen.
    expect(policy.fleetFallbackCapMinor(market)).toBe(code === 'AU' ? 1000 : 500);
    const bounds = policy.quoteBounds(market);
    if (code === 'ZZ') expect(bounds).toEqual({ minMinor: 300, maxMinor: 20000 });
    else expect(bounds === null || bounds.minMinor < bounds.maxMinor).toBe(true);
  });
});

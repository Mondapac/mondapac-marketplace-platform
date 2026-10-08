import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MAX_FACADE_BATCH } from '../../contracts/catalog.facade';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import { OfferSellUnitsSystemQuery } from './offer-sell-units-system.use-case';
import { OfferSellUnitsQuery } from './offer-sell-units.use-case';

// The fail-closed stand-in of `offerSellUnits` (ADR-0031 decision 6) through the facade, on both
// Market fixtures: every key absent for request and system callers, a malformed or oversized
// call refused whole. Catalog slice 7 replaces the stand-in and these cases run against it.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const offerId = (n: number) =>
  `01990000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Offer'>;

describe.each(TEST_MARKETS)('offerSellUnits stand-in in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const facade = new CatalogFacadeImplementation({
    offerSellUnits: new OfferSellUnitsQuery(gate),
    offerSellUnitsSystem: new OfferSellUnitsSystemQuery(gate),
  });

  it('declares the pair under their own names', () => {
    expect(OfferSellUnitsQuery.access).toEqual({
      name: 'catalog.offer-sell-units',
      rule: { kind: 'anonymous' },
    });
    expect(OfferSellUnitsSystemQuery.access).toEqual({
      name: 'catalog.offer-sell-units-system',
      rule: { kind: 'system' },
    });
  });

  it.each(['anonymous', 'system'] as const)('answers every key absent for %s', async (kind) => {
    const result = await facade.offerSellUnits(testCallContext(market, kind, 'offer-units-0001'), [
      offerId(1),
      offerId(2),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.size).toBe(0);
  });

  it('accepts an empty call and a call of exactly 200 ids', async () => {
    const context = testCallContext(market, 'system', 'offer-units-0002');
    await expect(facade.offerSellUnits(context, [])).resolves.toMatchObject({ ok: true });
    const full = Array.from({ length: MAX_FACADE_BATCH }, (_, i) => offerId(i + 1));
    await expect(facade.offerSellUnits(context, full)).resolves.toMatchObject({ ok: true });
  });

  it('refuses 201 ids whole', async () => {
    const tooMany = Array.from({ length: MAX_FACADE_BATCH + 1 }, (_, i) => offerId(i + 1));
    await expect(
      facade.offerSellUnits(testCallContext(market, 'system', 'offer-units-0003'), tooMany),
    ).resolves.toEqual({ ok: false, error: { code: 'batch.too-large' } });
  });

  it('refuses a malformed id and a non-array, naming the field and not the value', async () => {
    const context = testCallContext(market, 'anonymous', 'offer-units-0004');
    await expect(facade.offerSellUnits(context, ['not-an-id' as Id<'Offer'>])).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] },
    });
    await expect(
      facade.offerSellUnits(context, 'x' as unknown as readonly Id<'Offer'>[]),
    ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });
});

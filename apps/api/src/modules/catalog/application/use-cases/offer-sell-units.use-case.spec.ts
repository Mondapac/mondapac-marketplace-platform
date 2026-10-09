import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH, type OfferSellUnitsMap } from '../../contracts/catalog.facade';
import type { OfferSellUnitsReader } from '../ports/offer-sell-units.reader';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import { OfferSellUnitsSystemQuery } from './offer-sell-units-system.use-case';
import { OfferSellUnitsQuery } from './offer-sell-units.use-case';

// `offerSellUnits` through the facade on both Market fixtures: the request is checked whole
// before any read (200 ids at most, malformed refused), the read runs in one read-only unit on the
// context's Market only, an unknown id is absent, and the answer carries ids and flags only.
// The database behaviour of the reader is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const offerId = (n: number) =>
  `01990000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Offer'>;

describe.each(TEST_MARKETS)('offerSellUnits in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const reads: { market: string; ids: readonly Id<'Offer'>[] }[] = [];
  let known: OfferSellUnitsMap = new Map();
  const unitOfWork = {
    run: <T, E>(
      unitMarket: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push({ market: unitMarket.marketId, options });
      return work();
    },
  } as unknown as UnitOfWork;
  const reader: OfferSellUnitsReader = {
    read: (readMarket, ids) => {
      reads.push({ market: readMarket.marketId, ids });
      return Promise.resolve(new Map([...known].filter(([id]) => ids.includes(id))));
    },
  };
  const facade = new CatalogFacadeImplementation({
    offerSellUnits: new OfferSellUnitsQuery(gate, { unitOfWork, reader }),
    offerSellUnitsSystem: new OfferSellUnitsSystemQuery(gate, { unitOfWork, reader }),
  });
  beforeEach(() => {
    units.length = 0;
    reads.length = 0;
    known = new Map();
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

  it.each(['anonymous', 'system'] as const)(
    'reads the Offers of the context Market in one read-only unit for %s',
    async (kind) => {
      known = new Map([
        [
          offerId(1),
          {
            sellerId: offerId(90) as unknown as Id<'Seller'>,
            productId: offerId(91) as unknown as Id<'Product'>,
            status: 'published' as const,
            listed: true,
            sellUnits: [
              { variantId: offerId(92) as unknown as Id<'Variant'>, state: 'published' as const },
            ],
          },
        ],
      ]);
      const result = await facade.offerSellUnits(
        testCallContext(market, kind, 'offer-units-0001'),
        [offerId(1), offerId(2)],
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.value.keys()]).toEqual([offerId(1)]);
      expect(result.value.get(offerId(2))).toBeUndefined();
      expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
      expect(reads).toEqual([{ market: code, ids: [offerId(1), offerId(2)] }]);
    },
  );

  it('opens no unit for an empty call or a refused request', async () => {
    const context = testCallContext(market, 'system', 'offer-units-0008');
    await facade.offerSellUnits(context, []);
    await facade.offerSellUnits(context, ['nope' as Id<'Offer'>]);
    await facade.offerSellUnits(
      context,
      Array.from({ length: MAX_FACADE_BATCH + 1 }, (_, i) => offerId(i + 1)),
    );
    expect(units).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('answers an authenticated seller like any caller', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: '01990000-0000-7000-8000-00000000a002' as Id<'Account'>,
        sessionId: '01990000-0000-7000-8000-00000000a001' as Id<'Session'>,
        sellerId: '01990000-0000-7000-8000-00000000a003' as Id<'Seller'>,
      }),
      'offer-units-0005',
    );
    const result = await facade.offerSellUnits(seller, [offerId(1)]);
    expect(result.ok).toBe(true);
    expect(reads).toEqual([{ market: code, ids: [offerId(1)] }]);
  });

  it('accepts an empty call and a call of exactly 200 ids', async () => {
    const context = testCallContext(market, 'system', 'offer-units-0002');
    await expect(facade.offerSellUnits(context, [])).resolves.toMatchObject({ ok: true });
    const full = Array.from({ length: MAX_FACADE_BATCH }, (_, i) => offerId(i + 1));
    await expect(facade.offerSellUnits(context, full)).resolves.toMatchObject({ ok: true });
  });

  it('collapses duplicates after the length check', async () => {
    const context = testCallContext(market, 'system', 'offer-units-0006');
    await expect(facade.offerSellUnits(context, [offerId(1), offerId(1)])).resolves.toMatchObject({
      ok: true,
    });
    const duplicates = Array.from({ length: MAX_FACADE_BATCH + 1 }, () => offerId(1));
    await expect(facade.offerSellUnits(context, duplicates)).resolves.toEqual({
      ok: false,
      error: { code: 'batch.too-large' },
    });
  });

  it('refuses a non-string element', async () => {
    const context = testCallContext(market, 'system', 'offer-units-0007');
    await expect(
      facade.offerSellUnits(context, [7 as unknown as Id<'Offer'>]),
    ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
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

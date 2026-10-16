import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH, sellUnitKey, type SellUnitKey } from '../../contracts/catalog.facade';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import type { SellUnitLabelsReader } from '../ports/sell-unit-labels.reader';
import { SellUnitLabelsQuery } from './sell-unit-labels.use-case';

// `sellUnitLabels` through the facade on both Market fixtures: rule anonymous, the request is
// checked whole before any read, one read-only unit on the context's Market, and an unknown or
// foreign key is absent. What the reader returns (published content only) is in the db spec.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const uuid = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number): SellUnitKey => ({
  offerId: uuid(n) as Id<'Offer'>,
  variantId: uuid(n + 1000) as Id<'Variant'>,
});

describe.each(TEST_MARKETS)('sellUnitLabels in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const reads: { market: string; keys: readonly SellUnitKey[]; locale: string }[] = [];
  const stored = new Map<string, { market: string; productName: string }>();
  const unitOfWork = {
    run: <T, E>(
      m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push({ market: m.marketId, options });
      return work();
    },
  } as unknown as UnitOfWork;
  const reader: SellUnitLabelsReader = {
    read: (m, keys, locale) => {
      reads.push({ market: m.marketId, keys, locale });
      const answer = new Map<string, { productName: string; variantLabel: string | null }>();
      for (const k of keys) {
        const row = stored.get(sellUnitKey(k));
        if (row?.market === m.marketId)
          answer.set(sellUnitKey(k), { productName: row.productName, variantLabel: null });
      }
      return Promise.resolve(answer);
    },
  };
  const facade = new CatalogFacadeImplementation({
    sellUnitLabels: new SellUnitLabelsQuery(gate, { unitOfWork, labelsReader: reader }),
  } as never);
  beforeEach(() => {
    units.length = 0;
    reads.length = 0;
    stored.clear();
  });

  it('is declared anonymous', () => {
    expect(SellUnitLabelsQuery.access).toEqual({
      name: 'catalog.sell-unit-labels',
      rule: { kind: 'anonymous' },
    });
  });

  it('reads distinct keys in one read-only unit of the context Market; foreign keys are absent', async () => {
    stored.set(sellUnitKey(key(1)), { market: code, productName: 'Mine' });
    stored.set(sellUnitKey(key(2)), { market: otherCode(code), productName: 'CANARY' });
    const result = await facade.sellUnitLabels(
      testCallContext(market, 'anonymous', 'labels-0001'),
      [key(1), key(2), key(1), key(3)],
      'xx-YY',
    );
    expect(result.ok && [...result.value.keys()]).toEqual([sellUnitKey(key(1))]);
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(reads).toEqual([{ market: code, keys: [key(1), key(2), key(3)], locale: 'xx-YY' }]);
  });

  it('opens no unit for an empty call, a malformed key or a batch over the limit', async () => {
    const context = testCallContext(market, 'anonymous', 'labels-0002');
    expect((await facade.sellUnitLabels(context, [], 'en-AU')).ok).toBe(true);
    expect(
      await facade.sellUnitLabels(context, [{ offerId: 'nope', variantId: 'x' } as never], 'en-AU'),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] },
    });
    expect(
      await facade.sellUnitLabels(
        context,
        Array.from({ length: MAX_FACADE_BATCH + 1 }, (_, i) => key(i + 1)),
        'en-AU',
      ),
    ).toEqual({ ok: false, error: { code: 'batch.too-large' } });
    expect(units).toEqual([]);
    expect(reads).toEqual([]);
  });
});

function otherCode(code: string): string {
  return TEST_MARKETS.find((c) => c !== code)!;
}

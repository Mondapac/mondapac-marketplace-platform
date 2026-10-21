import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CertificationFacadeImplementation } from '../../presentation/certification.facade';
import type { CertifiedCategoriesReader } from '../ports/certified-categories.reader';
import { CertifiedCategories } from './certified-categories.use-case';

// `certifiedCategoryIds` in memory on both Market fixtures: ids of the reader are answered as they
// are, for a request actor of any kind (the gate gives the use case the anonymous actor), never
// for the system actor, and a failed read is `certification.unavailable`, never an empty list.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const category = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

describe.each(['AU', 'ZZ'] as const)('certifiedCategoryIds, Market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const asked: string[] = [];
  let answer: () => Promise<readonly Id<'Category'>[]>;
  const reader: CertifiedCategoriesReader = {
    categoryIds: (target) => {
      asked.push(target.marketId);
      return answer();
    },
  };
  const facade = () =>
    new CertificationFacadeImplementation({
      certifiedCategories: new CertifiedCategories(gate, reader),
    } as never);

  beforeEach(() => {
    asked.length = 0;
    answer = () => Promise.resolve([category(1), category(2)]);
  });

  it("answers the ids of the caller's Market only", async () => {
    const result = await facade().certifiedCategoryIds(testCallContext(market, 'anonymous'));

    expect(result).toEqual({ ok: true, value: [category(1), category(2)] });
    expect(asked).toEqual([code]);
  });

  it('serves a signed-in request actor as the anonymous one', async () => {
    const signedIn = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: category(0xa1) as unknown as Id<'Account'>,
        sessionId: category(0x61) as unknown as Id<'Session'>,
        sellerId: null,
      }),
      'cert-cats-abcdef',
    );
    const result = await facade().certifiedCategoryIds(signedIn);

    expect(result.ok).toBe(true);
  });

  it('refuses the system actor, which has its own pair of use cases elsewhere', async () => {
    const result = await facade().certifiedCategoryIds(testCallContext(market, 'system'));

    expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(asked).toEqual([]);
  });

  it('answers certification.unavailable when the read fails, never an empty list', async () => {
    answer = () => Promise.reject(new Error('database down'));

    expect(await facade().certifiedCategoryIds(testCallContext(market, 'anonymous'))).toEqual({
      ok: false,
      error: { code: 'certification.unavailable' },
    });
  });
});

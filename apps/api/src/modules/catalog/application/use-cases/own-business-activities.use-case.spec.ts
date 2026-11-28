import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessActivityState } from '../../domain/business-activity';
import type { BusinessActivityReader } from '../ports/business-activity.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { OwnBusinessActivities } from './own-business-activities.use-case';

// The list a seller picks the business activity from (BUG-012 step 2), on both Market fixtures:
// only ACTIVE activities, ids, codes and names only, seller population only, and a failing read is
// "unavailable", never an empty list.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true }),
});
const T0 = Temporal.Instant.from('2026-11-28T00:00:00Z');

describe.each([['AU'], ['ZZ']])('own business activities in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const state = (codeOf: string, status: 'active' | 'inactive'): BusinessActivityState =>
    ({
      id: ids.next<'BusinessActivity'>(),
      code: codeOf,
      status,
      names: [{ locale: 'en', name: codeOf.toUpperCase() }],
      description: 'internal note',
      categoryIds: [ids.next<'Category'>()],
      createdAt: T0,
      updatedAt: T0,
      version: 1,
    }) as unknown as BusinessActivityState;

  function build(read: () => Promise<readonly BusinessActivityState[]>) {
    const activityReader = { listActive: read } as unknown as BusinessActivityReader;
    const unitOfWork = {
      run: (_m: MarketContext, work: () => Promise<unknown>) => work(),
    } as unknown as UnitOfWork;
    const policy = {
      locales: () => ({ default: 'en', supported: ['en'] }),
    } as unknown as CatalogMarketPolicy;
    return new OwnBusinessActivities(gate, { unitOfWork, activityReader, policy });
  }

  const seller = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );

  it('answers ids, codes and names only, with the default locale', async () => {
    const butcher = state('butcher', 'active');
    const result = await build(() => Promise.resolve([butcher])).execute(seller(), {});
    expect(result.ok && result.value).toEqual({
      items: [{ id: butcher.id, code: 'butcher', names: { en: 'BUTCHER' } }],
      defaultLocale: 'en',
    });
    expect(JSON.stringify(result)).not.toContain('internal note');
  });

  it('is for the seller only', async () => {
    const use = build(() => Promise.resolve([]));
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    expect(await use.execute(admin, {})).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(await use.execute(testCallContext(market, 'anonymous'), {})).toMatchObject({
      ok: false,
    });
  });

  it('fails closed when the read fails', async () => {
    const use = build(() => Promise.reject(new Error('down')));
    expect(await use.execute(seller(), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});

import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { InMemoryStoreProfiles } from '../testing/in-memory-store-profiles';
import { SearchStoreNames } from './search-store-names.use-case';

// `searchStoreNames` (the admin order list's store-name search) with an in-memory store, on both
// Market fixtures: approved public names only, case insensitive, never across Markets, capped,
// and a failed read is `sellers.unavailable`, never an empty answer.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-10T10:00:00Z')));
const unitOfWork: UnitOfWork = {
  run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    return work();
  },
  runOnce: () => Promise.reject(new Error('not used')),
};

describe.each(TEST_MARKET_IDS)('SearchStoreNames in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const context = testCallContext(market, 'anonymous');
  let profiles: InMemoryStoreProfiles;
  let search: SearchStoreNames;
  const seller = () => ids.next<'Seller'>();
  const bad = {
    ok: false,
    error: { code: 'validation.failed', fields: [{ path: 'term', code: 'length' }] },
  };

  beforeEach(() => {
    profiles = new InMemoryStoreProfiles();
    search = new SearchStoreNames(gate, { unitOfWork, storeProfiles: profiles });
  });

  it('finds sellers by the approved public store name, ignoring case and spaces around', async () => {
    const butcher: Id<'Seller'> = seller();
    const baker: Id<'Seller'> = seller();
    profiles.put(market, butcher, { publicStoreName: 'Corner Butcher' });
    profiles.put(market, baker, { publicStoreName: 'Baker Bros' });

    expect(await search.execute(context, { term: '  BUTCH ' })).toEqual(
      ok({ sellerIds: [butcher], capped: false }),
    );
    expect(await search.execute(context, { term: 'nobody' })).toEqual(
      ok({ sellerIds: [], capped: false }),
    );
  });

  it('leaves out a seller without an approved revision and another Market', async () => {
    profiles.put(market, seller(), { publicStoreName: 'Draft Butcher', approved: false });
    profiles.put(other, seller(), { publicStoreName: 'Abroad Butcher' });

    expect(await search.execute(context, { term: 'butcher' })).toEqual(
      ok({ sellerIds: [], capped: false }),
    );
  });

  it('flags a match wider than 200 and answers 200', async () => {
    for (let n = 0; n < 201; n += 1) {
      profiles.put(market, seller(), { publicStoreName: `Shop ${n}` });
    }

    const answer = await search.execute(context, { term: 'shop' });
    expect(answer.ok && answer.value.sellerIds).toHaveLength(200);
    expect(answer.ok && answer.value.capped).toBe(true);
  });

  it('refuses a term that is too short or too long, reading nothing', async () => {
    expect(await search.execute(context, { term: ' a ' })).toEqual(bad);
    expect(await search.execute(context, { term: 'x'.repeat(81) })).toEqual(bad);
    expect(await search.execute(context, { term: 3 as never })).toEqual(bad);
  });

  it('answers sellers.unavailable when the read fails', async () => {
    profiles.failReads = true;
    expect(await search.execute(context, { term: 'butcher' })).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });
});

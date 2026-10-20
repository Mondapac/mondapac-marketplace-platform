import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ApprovedStoreFacts } from '../../domain/published-store';
import type { AccessState } from '../../domain/seller-status';
import { MarketConfigMinimumOrderPolicy } from '../../infrastructure/market-config-minimum-order-policy';
import type { PublishedStoreRepository } from '../ports/published-store.repository';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type {
  ApprovedSellingFacts,
  SellingFactsRepository,
} from '../ports/selling-facts.repository';
import type { StoreProfileRepository } from '../ports/store-profile.repository';
import { PublishedStoreList } from './published-store-list.use-case';
import { PublishedStoreRead } from './published-store-read.use-case';

// The public store reads (slice 12) with in-memory ports, on both Market fixtures (AU in AUD, ZZ
// in JPY): only stores that may sell now, allow-listed fields only, sorts and pages, the minimum
// order and its currency check, and the fail-closed answers. The PostgreSQL reads are covered by
// test/db/sellers-public-stores.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const minimumOrderPolicy = new MarketConfigMinimumOrderPolicy(markets);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-10T10:00:00Z')));

const unitOfWork: UnitOfWork = {
  run<T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) {
    return work();
  },
  runOnce: () => Promise.reject(new Error('not used')),
};

describe.each([
  ['AU', 'AUD', 'Australia/Brisbane'],
  ['ZZ', 'JPY', 'Pacific/Auckland'],
] as const)('public store reads, Market %s', (code, currency, zone) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = (): CallContext => testCallContext(market(), 'anonymous');
  let stores: ApprovedStoreFacts[];
  let facts: Map<string, ApprovedSellingFacts>;
  let states: Map<string, AccessState>;
  let minimums: Map<string, Money | null>;
  let failStores: boolean;
  let identityCalls: number;
  let list: PublishedStoreList;
  let read: PublishedStoreRead;

  const addStore = (
    slug: string,
    name: string,
    firstApprovedAt: string,
    options: { state?: AccessState; minimum?: Money | null } = {},
  ): Id<'Seller'> => {
    const sellerId = ids.next<'Seller'>();
    stores.push({
      sellerId,
      slug,
      name,
      serviceAreaCode: 'area-1',
      operatingTimezone: zone,
      firstApprovedAt: Temporal.Instant.from(firstApprovedAt),
    });
    facts.set(sellerId, { hasIdentifier: true, operatingTimezone: zone, openClaimConflict: false });
    states.set(sellerId, options.state ?? 'approved');
    if (options.minimum !== undefined) minimums.set(sellerId, options.minimum);
    return sellerId;
  };

  beforeEach(() => {
    stores = [];
    facts = new Map();
    states = new Map();
    minimums = new Map();
    failStores = false;
    identityCalls = 0;
    const publishedStores: PublishedStoreRepository = {
      approvedStores: (_market, limit) =>
        failStores ? Promise.reject(new Error('down')) : Promise.resolve(stores.slice(0, limit)),
      approvedStoreBySlug: (_market, slug) =>
        Promise.resolve(stores.find((store) => store.slug === slug) ?? null),
    };
    const sellingFacts: SellingFactsRepository = {
      approvedSellingFacts: (_market, sellerIds) =>
        Promise.resolve(
          new Map(
            sellerIds.flatMap((id) => {
              const found = facts.get(id);
              return found === undefined ? [] : [[id, found] as const];
            }),
          ),
        ),
      allowedProductTypes: () => Promise.reject(new Error('not used')),
    };
    const accessReader = {
      accessOfMany: (_context: CallContext, sellerIds: readonly Id<'Seller'>[]) => {
        identityCalls += 1;
        return Promise.resolve(
          new Map(
            sellerIds.flatMap((id) => {
              const state = states.get(id);
              return state === undefined ? [] : [[id, state] as const];
            }),
          ),
        );
      },
    } as unknown as SellerAccessReader;
    const storeProfiles = {
      approvedMinimumOrders: (_market: MarketContext, sellerIds: readonly Id<'Seller'>[]) =>
        Promise.resolve(
          new Map(
            sellerIds.flatMap((id) =>
              minimums.has(id) ? [[id, minimums.get(id) ?? null] as const] : [],
            ),
          ),
        ),
    } as unknown as StoreProfileRepository;
    const policy = {
      businessIdentifier: () => ({ scheme: 'x', required: true, labelKey: 'x' }),
    } as unknown as SellerMarketPolicy;
    const deps = {
      unitOfWork,
      sellingFacts,
      accessReader,
      policy,
      publishedStores,
      storeProfiles,
      minimumOrderPolicy,
    };
    list = new PublishedStoreList(gate, deps);
    read = new PublishedStoreRead(gate, deps);
  });

  const page = async (input: Parameters<PublishedStoreList['execute']>[1] = {}) => {
    const result = await list.execute(anonymous(), input);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it('lists only stores that may sell now, by name, with the allow-listed fields', async () => {
    addStore('zeta-foods', 'Zeta Foods', '2025-03-01T00:00:00Z', { minimum: null });
    addStore('alpha-market', 'alpha market', '2026-01-10T00:00:00Z', {
      minimum: { amount: 3000n, currency },
    });
    addStore('gone-store', 'Gone Store', '2026-01-10T00:00:00Z', { state: 'suspended' });

    const answer = await page();

    expect(answer).toEqual({
      items: [
        {
          slug: 'alpha-market',
          name: 'alpha market',
          serviceAreaCode: 'area-1',
          sellingSince: 2026,
          minimumOrder: { amount: 3000n, currency },
        },
        {
          slug: 'zeta-foods',
          name: 'Zeta Foods',
          serviceAreaCode: 'area-1',
          sellingSince: 2025,
          minimumOrder: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 24,
    });
  });

  it('sorts newest first and pages with a stable order', async () => {
    addStore('b-store', 'B', '2026-05-01T00:00:00Z');
    addStore('a-store', 'A', '2026-05-01T00:00:00Z');
    addStore('c-store', 'C', '2026-06-01T00:00:00Z');

    const first = await page({ sort: 'newest', pageSize: 2 });
    const second = await page({ sort: 'newest', pageSize: 2, page: 2 });

    expect(first.items.map((item) => item.slug)).toEqual(['c-store', 'a-store']);
    expect(second.items.map((item) => item.slug)).toEqual(['b-store']);
    expect(second.total).toBe(3);
  });

  it("reads the selling-since year in the seller's own zone", async () => {
    // 31 Dec 2025 23:30 UTC is already 2026 in Brisbane and Auckland.
    addStore('new-year', 'New Year', '2025-12-31T23:30:00Z');

    expect((await page()).items[0]?.sellingSince).toBe(2026);
  });

  it("leaves the minimum out when its currency is not the Market's", async () => {
    addStore('odd-store', 'Odd', '2026-01-01T00:00:00Z', {
      minimum: { amount: 100n, currency: currency === 'AUD' ? 'JPY' : 'AUD' },
    });

    const [item] = (await page()).items;

    expect(item).toBeDefined();
    expect(item && 'minimumOrder' in item).toBe(false);
  });

  it('asks identity once per 100 stores', async () => {
    for (let n = 0; n < 150; n += 1) {
      addStore(`store-${n.toString().padStart(3, '0')}`, `Store ${n}`, '2026-01-01T00:00:00Z');
    }

    const answer = await page({ pageSize: 48 });

    expect(answer.total).toBe(150);
    expect(identityCalls).toBe(2);
  });

  it('refuses a bad sort, page or page size whole', async () => {
    const result = await list.execute(anonymous(), { sort: 'price', page: 0, pageSize: 49 });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'sort', code: 'one-of' },
          { path: 'page', code: 'range' },
          { path: 'pageSize', code: 'range' },
        ],
      },
    });
  });

  it('answers sellers.unavailable when the read fails, never a partial list', async () => {
    addStore('a-store', 'A', '2026-01-01T00:00:00Z');
    failStores = true;

    expect(await list.execute(anonymous(), {})).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  it('reads one store by its exact slug', async () => {
    addStore('alpha-market', 'Alpha', '2026-01-10T00:00:00Z', { minimum: null });

    expect(await read.execute(anonymous(), { slug: 'alpha-market' })).toEqual(
      ok({
        slug: 'alpha-market',
        name: 'Alpha',
        serviceAreaCode: 'area-1',
        sellingSince: 2026,
        minimumOrder: null,
      }),
    );
  });

  it.each([
    ['a store that may not sell', 'held-back', 'held-back'],
    ['an unknown slug', 'held-back', 'no-such-store'],
    ['a slug in another case', 'held-back', 'Held-Back'],
    ['a malformed slug', 'held-back', '../x'],
  ])('answers not found alike for %s', async (_name, stored, asked) => {
    addStore(stored, 'Held', '2026-01-10T00:00:00Z', {
      state: asked === stored ? 'suspended' : 'approved',
    });

    expect(await read.execute(anonymous(), { slug: asked })).toEqual({
      ok: false,
      error: { code: 'sellers.store-not-found' },
    });
  });
});

import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../catalog';
import { PrismaLiveListingCounter } from '../infrastructure/prisma-live-listing-counter';
import type { LiveListingCounter } from './ports/live-listing-counter';
import { CountLiveListings } from './use-cases/count-live-listings.use-case';

// The live-listings count of the admin dashboard's supply and health card (dashboards v2, phase 1,
// PR 6), on both Market fixtures: the catalog key, platform admins acting as themselves only, the
// caller's Market, `access.unavailable` when stopped or failing, and the two statements.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

let declarations: AccessDeclaration[];
let reads: MarketContext[];
let failing: boolean;

const gate = createUseCaseGate(markets, {
  check: (_context, declaration) => {
    declarations.push(declaration);
    return Promise.resolve({ allowed: true as const });
  },
});
const unitOfWork = {
  run: (_market: MarketContext, work: () => Promise<unknown>, options?: { readOnly?: boolean }) => {
    if (options?.readOnly !== true) throw new Error('expected a read-only unit');
    return work();
  },
} as unknown as UnitOfWork;
const counts: LiveListingCounter = {
  liveListings: (market) => {
    reads.push(market);
    return failing
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ active: 40, outOfStock: 3 });
  },
};

beforeEach(() => {
  declarations = [];
  reads = [];
  failing = false;
});

describe.each(TEST_MARKETS)('search.count-live-listings in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const useCase = new CountLiveListings(gate, { unitOfWork, counts });
  const actor = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0xa2),
        sellerId: population === 'seller' ? id(0xa3) : null,
      }),
    );
  const query = (signal: AbortSignal = new AbortController().signal) => ({ signal });

  it("counts behind the catalog key, in the caller's Market", async () => {
    expect(await useCase.execute(actor('admin'), query())).toEqual(
      ok({ active: 40, outOfStock: 3 }),
    );
    expect(declarations.map((d) => d.rule)).toEqual([
      { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
    ]);
    expect(reads).toEqual([market]);
  });

  it('refuses a seller before any read; unavailable when stopped or failing', async () => {
    expect(await useCase.execute(actor('seller'), query())).toEqual(err({ code: 'access.denied' }));
    const stopped = new AbortController();
    stopped.abort();
    expect(await useCase.execute(actor('admin'), query(stopped.signal))).toEqual(
      err({ code: 'access.unavailable' }),
    );
    expect(reads).toHaveLength(0);
    failing = true;
    expect(await useCase.execute(actor('admin'), query())).toEqual(
      err({ code: 'access.unavailable' }),
    );
  });

  it('reads every document of the Market, and those with no sell unit in stock', async () => {
    const calls: unknown[] = [];
    const prisma = {
      tx: () => ({
        searchOfferDocument: {
          count: (args: unknown) => {
            calls.push(args);
            return Promise.resolve(calls.length === 1 ? 40 : 3);
          },
        },
      }),
    } as unknown as PrismaService;
    expect(await new PrismaLiveListingCounter(prisma).liveListings(market)).toEqual({
      active: 40,
      outOfStock: 3,
    });
    expect(calls).toEqual([
      { where: { marketId: market.marketId } },
      { where: { marketId: market.marketId, variants: { none: { inStock: true } } } },
    ]);
  });
});

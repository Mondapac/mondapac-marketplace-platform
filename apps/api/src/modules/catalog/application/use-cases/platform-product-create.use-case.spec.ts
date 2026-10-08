import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { ProductRepository } from '../ports/product.repository';
import { PlatformProductCreate } from './platform-product-create.use-case';

// `platform-product.create` in memory (catalog design 4.2 first row; slice 6), on both Market
// fixtures with the Market's real configuration: the type list and the default family come from
// the Market file, the request names the type only. The gate admits every authenticated actor;
// the declaration is checked by the CI list. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('platform-product.create in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  function rig(options: { familySeeded?: boolean } = {}) {
    const stored: Product[] = [];
    const events: unknown[] = [];
    const families: string[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products: ProductRepository = {
      nextProductCode: () => Promise.resolve(`P${String(stored.length + 1).padStart(8, '0')}`),
      add: (_m, product) => {
        stored.push(product);
        return Promise.resolve();
      },
      findById: () => Promise.resolve(null),
      save: () => Promise.resolve(),
    };
    const attributes = {
      loadSchema: (_m: MarketContext, familyCode: string) => {
        families.push(familyCode);
        return Promise.resolve(options.familySeeded === false ? null : { fields: [] });
      },
    } as unknown as AttributeRepository;
    const outbox: OutboxWriter = {
      append: (_c, list) => {
        events.push(...list);
        return Promise.resolve();
      },
    };
    const handlers = { simple: simpleProductType, configurable: configurableProductType };
    const useCase = new PlatformProductCreate(gate, {
      unitOfWork,
      products,
      attributes,
      policy,
      productTypes: (typeCode) => handlers[typeCode as keyof typeof handlers],
      outbox,
      clock,
      ids,
    });
    return { useCase, stored, events, families };
  }

  it('creates a PLATFORM Simple draft in the default family with its one variant', async () => {
    const r = rig();
    const created = await r.useCase.execute(contextOf('admin'), { typeCode: 'simple' });
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value.variantIds).toHaveLength(1);
    const state = r.stored[0]!.state;
    expect(state).toMatchObject({
      scope: 'PLATFORM',
      ownerSellerId: null,
      status: 'draft',
      typeCode: 'simple',
      familyCode: 'default',
      productCode: created.value.productCode,
      marketId: code,
    });
    expect(r.families).toEqual(['default']);
    expect(r.events.length).toBeGreaterThan(0);
  });

  it('offers Configurable only in a Market that lists it', async () => {
    const r = rig();
    const created = await r.useCase.execute(contextOf('admin'), { typeCode: 'configurable' });
    if (code === 'AU') {
      expect(created.ok && created.value.variantIds).toEqual([]);
    } else {
      expect(created).toEqual({ ok: false, error: { code: 'product.type-not-offered' } });
      expect(r.stored).toHaveLength(0);
    }
  });

  it('refuses an unlisted type, an unseeded family, a seller and a customer, storing nothing', async () => {
    const r = rig({ familySeeded: false });
    expect(await r.useCase.execute(contextOf('admin'), { typeCode: 'simple' })).toEqual({
      ok: false,
      error: { code: 'product.family-unavailable' },
    });
    expect(await r.useCase.execute(contextOf('admin'), { typeCode: 'nope' })).toEqual({
      ok: false,
      error: { code: 'product.type-not-offered' },
    });
    for (const population of ['seller', 'customer'] as const) {
      expect(await r.useCase.execute(contextOf(population), { typeCode: 'simple' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(r.stored).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  it('refuses a malformed request', async () => {
    const r = rig();
    const bad = await r.useCase.execute(contextOf('admin'), {
      typeCode: 5 as unknown as string,
    });
    expect(!bad.ok && bad.error.code).toBe('validation.failed');
  });
});

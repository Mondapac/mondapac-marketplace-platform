import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
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
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import type { ProductRepository } from '../ports/product.repository';
import { PlatformProductDiscard } from './platform-product-discard.use-case';

// `platform-product.discard` in memory on both Market fixtures: a never-submitted PLATFORM draft is
// discarded with its variants retired and announced; a SELLER product, a missing one and one
// already discarded answer the same `product.not-found`; a submitted product is refused.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('platform-product.discard in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  function product(scope: 'SELLER' | 'PLATFORM', simple = true): Product {
    const sellerId = ids.next<'Seller'>();
    const created = Product.create({
      id: ids.next<'Product'>(),
      marketId: code as MarketId,
      scope,
      sellerId: scope === 'SELLER' ? sellerId : null,
      handler: simple ? simpleProductType : configurableProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: simple ? ids.next<'Variant'>() : null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return Product.restore({ ...created.value.state, version: 1 });
  }

  function rig(initial: readonly Product[], staleOnSave = false) {
    const stored = new Map(initial.map((item) => [item.state.id as string, item]));
    const events: string[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products = {
      findById: (_m: MarketContext, id: string) => Promise.resolve(stored.get(id) ?? null),
      save: (_m: MarketContext, item: Product) => {
        if (staleOnSave) throw new StaleAggregateError('Product', item.state.id);
        stored.set(item.state.id, Product.restore({ ...item.state }));
        return Promise.resolve();
      },
    } as unknown as ProductRepository;
    const outbox: OutboxWriter = {
      append: (_c, list) => {
        events.push(...list.map(() => 'event'));
        return Promise.resolve();
      },
    };
    const useCase = new PlatformProductDiscard(gate, { unitOfWork, products, outbox, clock });
    return { stored, events, useCase };
  }

  it('discards a never-submitted platform draft, retires its variant and announces it', async () => {
    const draft = product('PLATFORM');
    const { stored, events, useCase } = rig([draft]);
    const result = await useCase.execute(contextOf('admin'), { productId: draft.state.id });
    expect(result).toEqual({ ok: true, value: { productId: draft.state.id } });
    const after = stored.get(draft.state.id)!;
    expect(after.state.status).toBe('discarded');
    expect(after.state.variants.every((variant) => variant.state === 'retired')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('answers one product.not-found for a SELLER product, a missing one and a discarded one', async () => {
    const sellerProduct = product('SELLER');
    const discarded = product('PLATFORM');
    discarded.discard(T0);
    const { stored, useCase } = rig([sellerProduct, discarded]);
    const admin = contextOf('admin');
    const answers = await Promise.all([
      useCase.execute(admin, { productId: sellerProduct.state.id }),
      useCase.execute(admin, { productId: ids.next<'Product'>() }),
      useCase.execute(admin, { productId: discarded.state.id }),
      useCase.execute(admin, { productId: 'not-an-id' }),
    ]);
    for (const answer of answers)
      expect(answer).toEqual({ ok: false, error: { code: 'product.not-found' } });
    expect(stored.get(sellerProduct.state.id)!.state.status).toBe('draft');
  });

  it('refuses a product that was already submitted, and a non-admin caller', async () => {
    const submitted = Product.restore({
      ...product('PLATFORM').state,
      status: 'unpublished',
      version: 2,
    });
    const { stored, events, useCase } = rig([submitted]);
    const refused = await useCase.execute(contextOf('admin'), { productId: submitted.state.id });
    expect(refused).toEqual({ ok: false, error: { code: 'product.not-a-draft' } });
    expect(stored.get(submitted.state.id)!.state.status).toBe('unpublished');
    expect(events).toHaveLength(0);
    const seller = await useCase.execute(contextOf('seller'), { productId: submitted.state.id });
    expect(seller).toEqual({ ok: false, error: { code: 'access.denied' } });
  });

  it('answers conflict.stale when the product moved since it was read', async () => {
    const draft = product('PLATFORM');
    const { useCase } = rig([draft], true);
    const result = await useCase.execute(contextOf('admin'), { productId: draft.state.id });
    expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });
});

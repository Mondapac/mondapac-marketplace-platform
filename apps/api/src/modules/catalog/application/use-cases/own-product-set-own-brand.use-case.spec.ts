import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Product } from '../../domain/product';
import { simpleProductType } from '../../domain/product-types/simple';
import type { ProductRepository } from '../ports/product.repository';
import { OwnProductSetOwnBrand } from './own-product-set-own-brand.use-case';

// The seller's own-brand flag (attributes A5): the write path #552 lacked, so that
// `own-brand.propose` can ever succeed. Both Market fixtures; the route is in
// test/catalog-own-product.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-03T10:00:00Z');
const T1 = Temporal.Instant.from('2026-11-03T11:00:00Z');
const SELLER = '01990000-0000-7000-8000-0000000000a3' as Id<'Seller'>;
const OTHER = '01990000-0000-7000-8000-0000000000a4' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-0000000000b1' as Id<'Product'>;

describe.each(['AU', 'ZZ'] as const)('own-product.set-own-brand in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (sellerId: Id<'Seller'> | null = SELLER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: sellerId === null ? 'admin' : 'seller',
        accountId: '01990000-0000-7000-8000-0000000000a1' as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId,
      }),
    );

  let stored: Product | null;
  let saves: number;
  let eligible: boolean;
  let staleOnSave: boolean;
  const products = {
    findById: (_m: MarketContext, id: Id<'Product'>) =>
      Promise.resolve(stored !== null && stored.state.id === id ? stored : null),
    save: (_m: MarketContext, product: Product) => {
      if (staleOnSave) throw new StaleAggregateError('Product', product.state.id);
      saves += 1;
      stored = Product.restore(product.state);
      return Promise.resolve();
    },
  } as unknown as ProductRepository;
  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_OWN_PRODUCT_EDIT.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;

  const useCase = () =>
    new OwnProductSetOwnBrand(createUseCaseGate(markets, check), {
      unitOfWork,
      products,
      eligibility: { isEligible: () => Promise.resolve(eligible) },
      clock: new FixedClock(T1),
    });

  const product = (scope: 'SELLER' | 'PLATFORM' = 'SELLER') => {
    const created = Product.create({
      id: PRODUCT,
      marketId: market.marketId,
      scope,
      sellerId: scope === 'SELLER' ? SELLER : null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: '01990000-0000-7000-8000-0000000000c1' as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return Product.restore(created.value.state);
  };

  beforeEach(() => {
    stored = product();
    saves = 0;
    eligible = true;
    staleOnSave = false;
  });

  it('sets and clears the flag on the seller own product', async () => {
    const on = await useCase().execute(context(), { productId: PRODUCT, ownBrand: true });
    expect(on).toEqual({ ok: true, value: { productId: PRODUCT, ownBrand: true } });
    expect(stored?.state.ownBrand).toBe(true);

    const off = await useCase().execute(context(), { productId: PRODUCT, ownBrand: false });
    expect(off).toEqual({ ok: true, value: { productId: PRODUCT, ownBrand: false } });
    expect(stored?.state.ownBrand).toBe(false);
    expect(saves).toBe(2);
  });

  it('writes nothing when the flag already has the value', async () => {
    const answer = await useCase().execute(context(), { productId: PRODUCT, ownBrand: false });

    expect(answer).toMatchObject({ ok: true });
    expect(saves).toBe(0);
  });

  it('answers one product.not-found for another seller, a PLATFORM product and an unknown id', async () => {
    const other = await useCase().execute(context(OTHER), { productId: PRODUCT, ownBrand: true });
    stored = product('PLATFORM');
    const platform = await useCase().execute(context(), { productId: PRODUCT, ownBrand: true });
    const unknown = await useCase().execute(context(), {
      productId: '01990000-0000-7000-8000-0000000000ff',
      ownBrand: true,
    });

    for (const answer of [other, platform, unknown]) {
      expect(answer).toEqual({ ok: false, error: { code: 'product.not-found' } });
    }
    expect(saves).toBe(0);
  });

  it('hides a discarded product', async () => {
    const draft = product();
    draft.discard(T1);
    stored = Product.restore(draft.state);

    const answer = await useCase().execute(context(), { productId: PRODUCT, ownBrand: true });

    expect(answer).toEqual({ ok: false, error: { code: 'product.not-found' } });
  });

  it('refuses a seller who may not sell, an admin and a malformed request', async () => {
    eligible = false;
    const notEligible = await useCase().execute(context(), { productId: PRODUCT, ownBrand: true });
    eligible = true;
    const admin = await useCase().execute(context(null), { productId: PRODUCT, ownBrand: true });
    const badId = await useCase().execute(context(), { productId: 'x', ownBrand: true });
    const badFlag = await useCase().execute(context(), { productId: PRODUCT, ownBrand: 'yes' });

    expect(notEligible).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
    expect(admin).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(badId).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(badFlag).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'ownBrand', code: 'type' }] },
    });
  });

  it('answers conflict.stale when the product changed under the write', async () => {
    staleOnSave = true;

    const answer = await useCase().execute(context(), { productId: PRODUCT, ownBrand: true });

    expect(answer).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });
});

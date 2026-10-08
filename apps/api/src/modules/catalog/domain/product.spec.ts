import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Product, formatProductCode } from './product';
import { configurableProductType } from './product-types/configurable';
import { simpleProductType } from './product-types/simple';

// Set per fixture Market by the describe.each below; the domain is Market-agnostic and the
// variant limit is an input from Market configuration.
let MARKET = 'ZZ' as MarketId;
const FIXTURE_MARKETS = [
  { code: 'AU', maxVariants: 100 },
  { code: 'ZZ', maxVariants: 3 },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-08T01:00:00Z');
const productId = 'p1' as Id<'Product'>;
const variant = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;
const seller = 's1' as Id<'Seller'>;

function simple(scope: 'SELLER' | 'PLATFORM' = 'SELLER'): Product {
  const created = Product.create({
    id: productId,
    marketId: MARKET,
    scope,
    sellerId: scope === 'SELLER' ? seller : null,
    handler: simpleProductType,
    familyCode: 'default',
    productCode: 'P00000001',
    variantId: variant(1),
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function configurable(): Product {
  const created = Product.create({
    id: productId,
    marketId: MARKET,
    scope: 'SELLER',
    sellerId: seller,
    handler: configurableProductType,
    familyCode: 'default',
    productCode: 'P00000002',
    variantId: null,
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

/** The product as storage gives it back: events gone, version as stored. */
const reloaded = (product: Product): Product => Product.restore(product.state);

describe.each(FIXTURE_MARKETS)('product in market $code', ({ code }) => {
  beforeEach(() => {
    MARKET = code as MarketId;
  });

  describe('Product.create', () => {
    it('creates a Simple draft with its one proposed variant and announces it', () => {
      const product = simple();

      expect(product.state).toMatchObject({
        status: 'draft',
        scope: 'SELLER',
        ownerSellerId: seller,
        createdBySellerId: seller,
        ownBrand: false,
        version: 1,
        discardedAt: null,
      });
      expect(product.state.variants).toEqual([
        { id: variant(1), state: 'proposed', createdAt: T0, publishedAt: null, retiredAt: null },
      ]);
      expect(product.persistedVersion).toBeNull();
      expect(product.pendingEvents).toHaveLength(1);
      expect(product.pendingEvents[0]).toMatchObject({
        type: 'catalog.variant-added.v1',
        aggregateId: productId,
        aggregateVersion: 1,
        payload: { productId, variantId: variant(1) },
      });
    });

    it('creates a Configurable draft with no variant and no event', () => {
      const product = configurable();

      expect(product.state.variants).toEqual([]);
      expect(product.state.version).toBe(1);
      expect(product.pendingEvents).toEqual([]);
    });

    it('creates a PLATFORM product without an owner', () => {
      expect(simple('PLATFORM').state).toMatchObject({
        scope: 'PLATFORM',
        ownerSellerId: null,
        createdBySellerId: null,
      });
    });

    it('refuses a scope and an owner that disagree', () => {
      for (const [scope, sellerId] of [
        ['SELLER', null],
        ['PLATFORM', seller],
      ] as const) {
        const result = Product.create({
          id: productId,
          marketId: MARKET,
          scope,
          sellerId,
          handler: configurableProductType,
          familyCode: 'default',
          productCode: 'P00000003',
          variantId: null,
          now: T0,
        });
        expect(result).toEqual({ ok: false, error: { code: 'product.scope-owner-mismatch' } });
      }
    });

    it('needs a variant id for a Simple product', () => {
      expect(() =>
        Product.create({
          id: productId,
          marketId: MARKET,
          scope: 'PLATFORM',
          sellerId: null,
          handler: simpleProductType,
          familyCode: 'default',
          productCode: 'P00000004',
          variantId: null,
          now: T0,
        }),
      ).toThrow(TypeError);
    });
  });

  describe('variants of a Configurable product', () => {
    it('adds a proposed variant, one event, version raised by one', () => {
      const product = reloaded(configurable());

      expect(product.addVariant(variant(1), 3, T1)).toEqual({ ok: true, value: undefined });

      expect(product.state.version).toBe(2);
      expect(product.state.lastChangedAt).toBe(T1);
      expect(product.liveVariants.map((v) => v.id)).toEqual([variant(1)]);
      expect(product.pendingEvents).toHaveLength(1);
      expect(product.pendingEvents[0]).toMatchObject({
        type: 'catalog.variant-added.v1',
        aggregateVersion: 2,
        payload: { variantId: variant(1) },
      });
    });

    it('gives each of several events its own version', () => {
      const product = reloaded(configurable());
      product.addVariant(variant(1), 3, T1);
      product.addVariant(variant(2), 3, T1);

      expect(product.state.version).toBe(3);
      expect(product.pendingEvents.map((event) => event.aggregateVersion)).toEqual([2, 3]);
    });

    it('refuses a variant beyond the limit, counting only the live ones', () => {
      const product = reloaded(configurable());
      product.addVariant(variant(1), 2, T1);
      product.addVariant(variant(2), 2, T1);

      expect(product.addVariant(variant(3), 2, T1)).toEqual({
        ok: false,
        error: { code: 'variant.limit-reached' },
      });
      expect(product.removeProposedVariant(variant(1), T1).ok).toBe(true);
      expect(product.addVariant(variant(3), 2, T1).ok).toBe(true);
      // The retired id stays in the registry and is never revived.
      expect(product.state.variants.map((v) => [v.id, v.state])).toEqual([
        [variant(1), 'retired'],
        [variant(2), 'proposed'],
        [variant(3), 'proposed'],
      ]);
    });

    it('announces the removal of a proposed variant, once', () => {
      const product = reloaded(configurable());
      product.addVariant(variant(1), 3, T1);
      product.removeProposedVariant(variant(1), T1);

      expect(product.pendingEvents.map((event) => event.type)).toEqual([
        'catalog.variant-added.v1',
        'catalog.variant-removed.v1',
      ]);
      expect(product.removeProposedVariant(variant(1), T1)).toEqual({
        ok: false,
        error: { code: 'variant.not-proposed' },
      });
      expect(product.removeProposedVariant(variant(9), T1)).toEqual({
        ok: false,
        error: { code: 'variant.not-found' },
      });
    });

    it('refuses to add or remove a variant of a Simple product', () => {
      const product = reloaded(simple());

      expect(product.addVariant(variant(2), 3, T1)).toEqual({
        ok: false,
        error: { code: 'variant.fixed' },
      });
      expect(product.removeProposedVariant(variant(1), T1)).toEqual({
        ok: false,
        error: { code: 'variant.fixed' },
      });
      expect(product.pendingEvents).toEqual([]);
      expect(product.state.version).toBe(1);
    });
  });

  describe('Product.discard', () => {
    it('discards a Simple draft: the single variant is retired and announced', () => {
      const product = reloaded(simple());

      expect(product.discard(T1)).toEqual({ ok: true, value: undefined });

      expect(product.state).toMatchObject({ status: 'discarded', discardedAt: T1, version: 2 });
      expect(product.state.variants[0]).toMatchObject({ state: 'retired', retiredAt: T1 });
      expect(product.pendingEvents).toHaveLength(1);
      expect(product.pendingEvents[0]).toMatchObject({
        type: 'catalog.variant-removed.v1',
        aggregateVersion: 2,
        payload: { productId, variantId: variant(1) },
      });
    });

    it('retires every live variant of a Configurable draft, one event each, in order', () => {
      const product = reloaded(configurable());
      product.addVariant(variant(1), 5, T1);
      product.addVariant(variant(2), 5, T1);
      product.addVariant(variant(3), 5, T1);
      product.removeProposedVariant(variant(2), T1);
      const saved = reloaded(product);

      saved.discard(T1);

      expect(saved.pendingEvents.map((event) => event.payload)).toEqual([
        { productId, variantId: variant(1) },
        { productId, variantId: variant(3) },
      ]);
      expect(saved.pendingEvents.map((event) => event.aggregateVersion)).toEqual([
        product.state.version + 1,
        product.state.version + 2,
      ]);
      expect(saved.liveVariants).toEqual([]);
    });

    it('raises the version by one when a Configurable draft with no variant is discarded', () => {
      const product = reloaded(configurable());

      product.discard(T1);

      expect(product.state.version).toBe(2);
      expect(product.pendingEvents).toEqual([]);
    });

    it('discards only a draft, and only once', () => {
      const product = reloaded(simple());
      product.discard(T1);
      const again = reloaded(product);

      expect(again.discard(T1)).toEqual({ ok: false, error: { code: 'product.not-a-draft' } });
      expect(again.pendingEvents).toEqual([]);
    });
  });

  it('refuses to add or remove a variant once the product is discarded', () => {
    const product = reloaded(configurable());
    product.addVariant(variant(1), 5, T1);
    product.discard(T1);

    expect(product.addVariant(variant(2), 5, T1)).toEqual({
      ok: false,
      error: { code: 'product.not-editable' },
    });
    expect(product.removeProposedVariant(variant(1), T1)).toEqual({
      ok: false,
      error: { code: 'product.not-editable' },
    });
  });

  it('refuses a variant id that is already in the registry, retired or not', () => {
    const product = reloaded(configurable());
    product.addVariant(variant(1), 5, T1);
    product.removeProposedVariant(variant(1), T1);

    expect(product.addVariant(variant(1), 5, T1)).toEqual({
      ok: false,
      error: { code: 'variant.id-taken' },
    });
  });

  it('keeps type, family and variant model unchanged by every command (CC2)', () => {
    const product = reloaded(configurable());
    const before = {
      typeCode: product.state.typeCode,
      familyCode: product.state.familyCode,
      variantModel: product.state.variantModel,
    };
    product.addVariant(variant(1), 5, T1);
    product.removeProposedVariant(variant(1), T1);
    product.discard(T1);

    expect({
      typeCode: product.state.typeCode,
      familyCode: product.state.familyCode,
      variantModel: product.state.variantModel,
    }).toEqual(before);
  });

  it('lets a Configurable draft drop its last live variant (the minimum binds at submit and publish)', () => {
    const product = reloaded(configurable());
    product.addVariant(variant(1), 5, T1);
    const saved = reloaded(product);

    expect(saved.removeProposedVariant(variant(1), T1).ok).toBe(true);
    expect(saved.liveVariants).toEqual([]);
  });

  it('refuses the variant beyond the Market limit, whatever the limit is', () => {
    const product = reloaded(configurable());
    const { maxVariants } = FIXTURE_MARKETS.find((entry) => entry.code === MARKET)!;
    for (let n = 1; n <= maxVariants; n++) {
      expect(product.addVariant(variant(n), maxVariants, T1).ok).toBe(true);
    }
    expect(product.addVariant(variant(maxVariants + 1), maxVariants, T1)).toEqual({
      ok: false,
      error: { code: 'variant.limit-reached' },
    });
  });
});

describe('formatProductCode', () => {
  it('pads the sequence to eight digits behind a P', () => {
    expect(formatProductCode(1)).toBe('P00000001');
    expect(formatProductCode(99_999_999)).toBe('P99999999');
  });

  it('refuses a sequence outside the range', () => {
    for (const value of [0, -1, 1.5, 100_000_000, Number.NaN]) {
      expect(() => formatProductCode(value)).toThrow(RangeError);
    }
  });
});

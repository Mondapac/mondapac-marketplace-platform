import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Product } from './product';
import { configurableProductType } from './product-types/configurable';
import { simpleProductType } from './product-types/simple';

// Product.saveWorkingCopy (catalog design 4.2 "Working-copy save", M-1, Ali B2, Hassan M3): the
// variant-id rule, the limit, the retirement of a deleted `proposed` variant with its event, and
// CAT-43 (a seller never writes a PLATFORM product). Both Market fixtures; the limit is an input.

const FIXTURE_MARKETS = [
  { code: 'AU', maxVariants: 100 },
  { code: 'ZZ', maxVariants: 3 },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-08T01:00:00Z');
const productId = 'p1' as Id<'Product'>;
const seller = 's1' as Id<'Seller'>;
const v = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;

describe.each(FIXTURE_MARKETS)(
  'Product.saveWorkingCopy in market $code',
  ({ code, maxVariants }) => {
    const marketId = code as MarketId;
    let minted = 100;
    const newId = (): Id<'Variant'> => v(++minted);
    beforeEach(() => {
      minted = 100;
    });

    function configurable(scope: 'SELLER' | 'PLATFORM' = 'SELLER', status = 'draft'): Product {
      const created = Product.create({
        id: productId,
        marketId,
        scope,
        sellerId: scope === 'SELLER' ? seller : null,
        handler: configurableProductType,
        familyCode: 'default',
        productCode: 'P00000002',
        variantId: null,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      return Product.restore({ ...created.value.state, status: status as 'draft' });
    }
    function simple(): Product {
      const created = Product.create({
        id: productId,
        marketId,
        scope: 'SELLER',
        sellerId: seller,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: 'P00000001',
        variantId: v(1),
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      return Product.restore(created.value.state);
    }
    const save = (
      product: Product,
      variantIds: readonly (Id<'Variant'> | null)[],
      authorKind: 'seller' | 'admin' = 'seller',
    ) => product.saveWorkingCopy({ authorKind, variantIds, maxVariants, newId, now: T1 });

    it('mints an id for a variant sent without one and announces it', () => {
      const product = configurable();
      const result = save(product, [null, null]);

      expect(result).toEqual({ ok: true, value: { variantIds: [v(101), v(102)] } });
      expect(product.liveVariants.map((variant) => variant.id)).toEqual([v(101), v(102)]);
      expect(product.pendingEvents.map((event) => event.type)).toEqual([
        'catalog.variant-added.v1',
        'catalog.variant-added.v1',
      ]);
      expect(product.state.version).toBe(3);
    });

    it('keeps the ids it already knows and records nothing for them', () => {
      const product = configurable();
      save(product, [null]);
      const saved = Product.restore(product.state);

      expect(save(saved, [v(101)])).toEqual({ ok: true, value: { variantIds: [v(101)] } });
      expect(saved.pendingEvents).toEqual([]);
      expect(saved.state.version).toBe(product.state.version);
    });

    it('refuses an id that is not a live variant of this product, whole save, same code', () => {
      const product = configurable();
      save(product, [null]);
      const saved = Product.restore(product.state);

      expect(save(saved, [v(101), v(999)])).toEqual({
        ok: false,
        error: { code: 'variant.unknown' },
      });
      expect(saved.pendingEvents).toEqual([]);
      expect(saved.liveVariants).toHaveLength(1);

      const retiring = Product.restore(product.state);
      save(retiring, []);
      const afterRetire = Product.restore(retiring.state);
      expect(save(afterRetire, [v(101)])).toEqual({
        ok: false,
        error: { code: 'variant.unknown' },
      });
    });

    it('retires a deleted proposed variant in the same save and announces it', () => {
      const product = configurable();
      save(product, [null, null]);
      const saved = Product.restore(product.state);

      expect(save(saved, [v(102)])).toEqual({ ok: true, value: { variantIds: [v(102)] } });
      expect(saved.liveVariants.map((variant) => variant.id)).toEqual([v(102)]);
      expect(saved.pendingEvents).toMatchObject([
        { type: 'catalog.variant-removed.v1', payload: { variantId: v(101) } },
      ]);
    });

    it('does not retire a published variant a save leaves out (the publish does)', () => {
      const product = configurable('SELLER', 'published');
      save(product, [null]);
      const state = product.state;
      const published = Product.restore({
        ...state,
        variants: state.variants.map((variant) => ({ ...variant, state: 'published' as const })),
      });

      expect(save(published, [])).toEqual({ ok: true, value: { variantIds: [] } });
      expect(published.liveVariants).toHaveLength(1);
      expect(published.pendingEvents).toEqual([]);
    });

    it('refuses the variant beyond the Market limit and saves nothing', () => {
      const product = configurable();
      const tooMany = Array.from({ length: maxVariants + 1 }, () => null);

      expect(save(product, tooMany)).toEqual({
        ok: false,
        error: { code: 'variant.limit-reached', max: maxVariants },
      });
      expect(product.liveVariants).toEqual([]);
      expect(product.pendingEvents).toEqual([]);
      expect(save(product, tooMany.slice(1)).ok).toBe(true);
    });

    it('counts a deletion in the same save against the limit', () => {
      const product = configurable();
      save(
        product,
        Array.from({ length: maxVariants }, () => null),
      );
      const full = Product.restore(product.state);
      const keep = full.liveVariants.slice(1).map((variant) => variant.id);

      expect(save(full, [...keep, null]).ok).toBe(true);
      expect(full.liveVariants).toHaveLength(maxVariants);
    });

    it('lets a Simple product save its one variant by id and refuses any other', () => {
      expect(save(simple(), [v(1)])).toEqual({ ok: true, value: { variantIds: [v(1)] } });
      expect(save(simple(), [])).toEqual({ ok: true, value: { variantIds: [v(1)] } });
      expect(save(simple(), [null])).toEqual({ ok: false, error: { code: 'variant.fixed' } });
      expect(save(simple(), [v(5)])).toEqual({ ok: false, error: { code: 'variant.unknown' } });
    });

    it('refuses a seller on a PLATFORM product and lets an admin save it (CAT-43)', () => {
      expect(save(configurable('PLATFORM'), [null], 'seller')).toEqual({
        ok: false,
        error: { code: 'product.platform-admin-only' },
      });
      expect(save(configurable('PLATFORM'), [null], 'admin').ok).toBe(true);
    });

    it('refuses a product that can no longer be edited', () => {
      for (const status of ['discarded', 'matched', 'withdrawn', 'retired']) {
        expect(save(configurable('SELLER', status), [null])).toEqual({
          ok: false,
          error: { code: 'product.not-editable' },
        });
      }
      for (const status of ['draft', 'unpublished', 'published']) {
        expect(save(configurable('SELLER', status), [null]).ok).toBe(true);
      }
    });

    it('orders retirements before additions, one version per event (Q-K3)', () => {
      const product = configurable();
      save(product, [null, null, null].slice(0, Math.min(3, maxVariants)));
      const saved = Product.restore(product.state);
      const base = saved.state.version;

      expect(save(saved, [null, null]).ok).toBe(true);
      expect(saved.pendingEvents.map((event) => event.type)).toEqual([
        'catalog.variant-removed.v1',
        'catalog.variant-removed.v1',
        'catalog.variant-removed.v1',
        'catalog.variant-added.v1',
        'catalog.variant-added.v1',
      ]);
      expect(saved.pendingEvents.map((event) => event.aggregateVersion)).toEqual([
        base + 1,
        base + 2,
        base + 3,
        base + 4,
        base + 5,
      ]);
      expect(saved.state.version).toBe(base + 5);
    });

    it('retires every proposed variant on an empty list, in creation order', () => {
      const product = configurable();
      save(product, [null, null]);
      const saved = Product.restore(product.state);

      expect(save(saved, [])).toEqual({ ok: true, value: { variantIds: [] } });
      expect(saved.pendingEvents).toMatchObject([
        { payload: { variantId: v(101) }, aggregateVersion: saved.state.version - 1 },
        { payload: { variantId: v(102) }, aggregateVersion: saved.state.version },
      ]);
      expect(saved.liveVariants).toEqual([]);
    });

    it('refuses a repeated id and mints nothing', () => {
      const product = configurable();
      save(product, [null]);
      const saved = Product.restore(product.state);
      const mint = jest.fn(newId);

      expect(
        saved.saveWorkingCopy({
          authorKind: 'seller',
          variantIds: [v(101), v(101), null],
          maxVariants,
          newId: mint,
          now: T1,
        }),
      ).toEqual({ ok: false, error: { code: 'variant.unknown' } });
      expect(mint).not.toHaveBeenCalled();
      expect(saved.pendingEvents).toEqual([]);
    });

    it('returns the ids in the order of the list, minting in list order', () => {
      const product = configurable();
      save(product, [null, null]);
      const saved = Product.restore(product.state);
      const wanted = maxVariants >= 3 ? [v(101), null, v(102)] : [v(101), null];

      expect(save(saved, wanted)).toEqual({
        ok: true,
        value: { variantIds: wanted.length === 3 ? [v(101), v(103), v(102)] : [v(101), v(103)] },
      });
    });

    it('adds and removes a variant on a published product, and discard still wants a draft', () => {
      const published = configurable('SELLER', 'published');
      expect(published.addVariant(v(7), maxVariants, T1, 'seller').ok).toBe(true);
      expect(published.removeProposedVariant(v(7), T1, 'seller').ok).toBe(true);
      expect(published.discard(T1)).toEqual({ ok: false, error: { code: 'product.not-a-draft' } });
    });

    it('refuses a seller on PLATFORM and an admin on SELLER, for every variant command (CAT-43)', () => {
      for (const status of ['draft', 'unpublished', 'published']) {
        const platform = configurable('PLATFORM', status);
        expect(platform.addVariant(v(7), maxVariants, T1, 'seller')).toEqual({
          ok: false,
          error: { code: 'product.platform-admin-only' },
        });
        expect(platform.removeProposedVariant(v(7), T1, 'seller')).toEqual({
          ok: false,
          error: { code: 'product.platform-admin-only' },
        });
        const owned = configurable('SELLER', status);
        expect(save(owned, [null], 'admin')).toEqual({
          ok: false,
          error: { code: 'product.seller-only' },
        });
        expect(owned.addVariant(v(7), maxVariants, T1, 'admin').ok).toBe(false);
      }
    });

    it('refuses add and remove on every status that is not editable', () => {
      for (const status of ['discarded', 'matched', 'withdrawn', 'retired']) {
        const product = configurable('SELLER', status);
        expect(product.addVariant(v(7), maxVariants, T1, 'seller')).toEqual({
          ok: false,
          error: { code: 'product.not-editable' },
        });
        expect(product.removeProposedVariant(v(7), T1, 'seller')).toEqual({
          ok: false,
          error: { code: 'product.not-editable' },
        });
      }
    });

    it('throws on a limit that would switch the check off', () => {
      for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        expect(() =>
          configurable().saveWorkingCopy({
            authorKind: 'seller',
            variantIds: [null],
            maxVariants: bad,
            newId,
            now: T1,
          }),
        ).toThrow(RangeError);
        expect(() => configurable().addVariant(v(7), bad, T1, 'seller')).toThrow(RangeError);
      }
    });
  },
);

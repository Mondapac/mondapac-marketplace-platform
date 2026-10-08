import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Product } from './product';
import type { RevisionOutcome } from './product-revision-policy';
import { configurableProductType } from './product-types/configurable';
import { simpleProductType } from './product-types/simple';

let MARKET = 'ZZ' as MarketId;
const FIXTURE_MARKETS = [
  { code: 'AU', maxVariants: 100 },
  { code: 'ZZ', maxVariants: 3 },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-08T01:00:00Z');
const T2 = Temporal.Instant.from('2026-10-08T02:00:00Z');
const productId = 'p1' as Id<'Product'>;
const seller = 's1' as Id<'Seller'>;
const v = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;
const rev = (n: number): Id<'ProductRevision'> => `r${n}` as Id<'ProductRevision'>;

const PUBLISHED: RevisionOutcome = {
  outcome: 'published',
  publishKind: 'auto',
  sensitive: false,
  reasons: [],
};
const PENDING: RevisionOutcome = {
  outcome: 'pending',
  publishKind: null,
  sensitive: true,
  reasons: ['never-published'],
};

function simple(scope: 'SELLER' | 'PLATFORM' = 'SELLER'): Product {
  const created = Product.create({
    id: productId,
    marketId: MARKET,
    scope,
    sellerId: scope === 'SELLER' ? seller : null,
    handler: simpleProductType,
    familyCode: 'default',
    productCode: 'P00000001',
    variantId: v(1),
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function configurableWith(count: number): Product {
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
  const product = created.value;
  for (let n = 1; n <= count; n += 1) {
    const added = product.addVariant(v(n), 100, T0, 'seller');
    if (!added.ok) throw new Error(added.error.code);
  }
  return product;
}

const submit = (
  product: Product,
  input: Partial<Parameters<Product['submitRevision']>[0]> & {
    readonly revisionId: Id<'ProductRevision'>;
  },
) =>
  product.submitRevision({
    baseRevisionId: product.state.publishedRevisionId,
    outcome: PUBLISHED,
    authorKind: 'seller',
    replacePending: false,
    revisionVariantIds: product.liveVariants.map((variant) => variant.id),
    maxVariants: 100,
    now: T1,
    ...input,
  });

const types = (product: Product): string[] => product.pendingEvents.map((event) => event.type);

describe.each(FIXTURE_MARKETS)('product revisions in market $code', ({ code }) => {
  beforeEach(() => {
    MARKET = code as MarketId;
  });

  describe('first publish', () => {
    it('moves draft to published, names the revision and publishes the proposed variant', () => {
      const product = simple();
      const result = submit(product, { revisionId: rev(1) });

      expect(result).toEqual({ ok: true, value: { published: true } });
      expect(product.state).toMatchObject({
        status: 'published',
        publishedRevisionId: rev(1),
        pendingRevisionId: null,
        pendingSubmittedAt: null,
      });
      expect(product.state.variants[0]).toMatchObject({ state: 'published', publishedAt: T1 });
      expect(types(product)).toEqual([
        'catalog.variant-added.v1',
        'catalog.product-revision-submitted.v1',
        'catalog.product-revision-published.v1',
      ]);
      expect(product.pendingEvents.map((event) => event.aggregateVersion)).toEqual([1, 2, 3]);
    });

    it('moves draft to unpublished when the revision waits for review', () => {
      const product = simple();
      const result = submit(product, { revisionId: rev(1), outcome: PENDING });

      expect(result).toEqual({ ok: true, value: { published: false } });
      expect(product.state).toMatchObject({
        status: 'unpublished',
        publishedRevisionId: null,
        pendingRevisionId: rev(1),
        pendingSubmittedAt: T1,
      });
      expect(product.state.variants[0]?.state).toBe('proposed');
      expect(types(product)).toContain('catalog.product-revision-submitted.v1');
      expect(types(product)).not.toContain('catalog.product-revision-published.v1');
    });
  });

  describe('AC 26: a pending revision holds later edits', () => {
    it('refuses a second submit unless it replaces the pending one', () => {
      const product = simple();
      submit(product, { revisionId: rev(1), outcome: PENDING });

      const refused = submit(product, { revisionId: rev(2), outcome: PENDING });
      expect(refused).toEqual({ ok: false, error: { code: 'revision.pending-exists' } });
      expect(product.state.pendingRevisionId).toBe(rev(1));

      const replaced = submit(product, {
        revisionId: rev(2),
        outcome: PENDING,
        replacePending: true,
        now: T2,
      });
      expect(replaced.ok).toBe(true);
      expect(product.state.pendingRevisionId).toBe(rev(2));
      expect(product.state.pendingSubmittedAt).toBe(T2);
    });

    it('lets a published replacement clear the pending pointer', () => {
      const product = simple();
      submit(product, { revisionId: rev(1), outcome: PENDING });
      const result = submit(product, { revisionId: rev(2), replacePending: true });

      expect(result.ok).toBe(true);
      expect(product.state).toMatchObject({
        publishedRevisionId: rev(2),
        pendingRevisionId: null,
      });
    });
  });

  describe('AC 29: approval is bound to the named pending revision', () => {
    it('publishes the pending revision when it is named', () => {
      const product = simple();
      submit(product, { revisionId: rev(1), outcome: PENDING });
      const result = product.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionVariantIds: [v(1)],
        maxVariants: 100,
        now: T2,
      });

      expect(result.ok).toBe(true);
      expect(product.state).toMatchObject({
        status: 'published',
        publishedRevisionId: rev(1),
        pendingRevisionId: null,
      });
      expect(product.state.variants[0]).toMatchObject({ state: 'published', publishedAt: T2 });
    });

    it('refuses a revision that is not the pending one and changes nothing', () => {
      const product = simple();
      submit(product, { revisionId: rev(1), outcome: PENDING });
      submit(product, { revisionId: rev(2), outcome: PENDING, replacePending: true });
      const before = product.state;
      const result = product.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionVariantIds: [v(1)],
        maxVariants: 100,
        now: T2,
      });

      expect(result).toEqual({ ok: false, error: { code: 'review.not-current-revision' } });
      expect(product.state).toEqual(before);
    });

    it('refuses an approval when nothing is pending', () => {
      const product = simple();
      const result = product.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionVariantIds: [v(1)],
        maxVariants: 100,
        now: T2,
      });
      expect(result).toEqual({ ok: false, error: { code: 'review.not-current-revision' } });
    });

    it('refuses with base-changed when the published revision moved after the submit', () => {
      const product = simple();
      submit(product, { revisionId: rev(1) });
      submit(product, { revisionId: rev(2), outcome: PENDING });
      product.publishTaxOverride({ revisionId: rev(3), now: T2 });
      const result = product.approveRevision({
        revisionId: rev(2),
        baseRevisionId: rev(1),
        revisionVariantIds: [v(1)],
        maxVariants: 100,
        now: T2,
      });
      expect(result).toEqual({ ok: false, error: { code: 'revision.base-changed' } });
      expect(product.state.pendingRevisionId).toBe(rev(2));
    });

    it('refuses cleanly when a variant was retired after the submit (Hassan I-1)', () => {
      const product = configurableWith(2);
      submit(product, { revisionId: rev(1), outcome: PENDING });
      product.removeProposedVariant(v(2), T1, 'seller');
      const result = product.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionVariantIds: [v(1), v(2)],
        maxVariants: 100,
        now: T2,
      });
      expect(result).toEqual({ ok: false, error: { code: 'variant.unknown' } });
      expect(product.state.status).toBe('unpublished');
    });

    it('is not available on a PLATFORM product', () => {
      const product = simple('PLATFORM');
      const result = product.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionVariantIds: [v(1)],
        maxVariants: 100,
        now: T2,
      });
      expect(result).toEqual({ ok: false, error: { code: 'product.seller-only' } });
    });
  });

  describe('base revision', () => {
    it('refuses a submit built on a revision that is no longer the published one', () => {
      const product = simple();
      submit(product, { revisionId: rev(1) });
      const result = submit(product, { revisionId: rev(2), baseRevisionId: null });
      expect(result).toEqual({ ok: false, error: { code: 'revision.base-changed' } });
    });
  });

  describe('AC 36: the tax override publishes at once and keeps the pending revision', () => {
    it('publishes over the published revision and leaves a pending seller revision alone', () => {
      const product = simple();
      submit(product, { revisionId: rev(1) });
      submit(product, { revisionId: rev(2), outcome: PENDING });
      const result = product.publishTaxOverride({ revisionId: rev(3), now: T2 });

      expect(result.ok).toBe(true);
      expect(product.state).toMatchObject({
        status: 'published',
        publishedRevisionId: rev(3),
        pendingRevisionId: rev(2),
      });
      const published = product.pendingEvents.filter(
        (event) => event.type === 'catalog.product-revision-published.v1',
      );
      expect(published.at(-1)?.payload).toMatchObject({
        revisionId: rev(3),
        previousRevisionId: rev(1),
      });
      expect(product.state.variants[0]?.state).toBe('published');
    });

    it('needs a published revision', () => {
      const product = simple();
      const result = product.publishTaxOverride({ revisionId: rev(1), now: T1 });
      expect(result).toEqual({ ok: false, error: { code: 'product.no-published-revision' } });
    });

    it('is not available on a PLATFORM product', () => {
      const product = simple('PLATFORM');
      const result = product.publishTaxOverride({ revisionId: rev(1), now: T1 });
      expect(result).toEqual({ ok: false, error: { code: 'product.seller-only' } });
    });
  });

  describe('variant lifecycle at publish (M-1)', () => {
    it('retires a published variant the new revision leaves out and announces it', () => {
      const product = configurableWith(2);
      submit(product, { revisionId: rev(1) });
      const result = submit(product, { revisionId: rev(2), revisionVariantIds: [v(1)] });

      expect(result.ok).toBe(true);
      expect(product.state.variants.map((variant) => variant.state)).toEqual([
        'published',
        'retired',
      ]);
      const removed = product.pendingEvents.filter(
        (event) => event.type === 'catalog.variant-removed.v1',
      );
      expect(removed.map((event) => event.payload)).toEqual([{ productId, variantId: v(2) }]);
    });

    it('publishes a newly proposed variant and keeps a published one named again', () => {
      const product = configurableWith(1);
      submit(product, { revisionId: rev(1) });
      product.addVariant(v(2), 100, T1, 'seller');
      submit(product, { revisionId: rev(2), revisionVariantIds: [v(1), v(2)] });

      expect(product.state.variants.map((variant) => variant.state)).toEqual([
        'published',
        'published',
      ]);
    });

    it('keeps event versions one per event, counting up from the stored version', () => {
      const product = Product.restore(configurableWith(2).state);
      submit(product, { revisionId: rev(1) });
      const versions = product.pendingEvents.map((event) => event.aggregateVersion);
      expect(versions).toEqual(
        versions.map((_, index) => product.state.version - versions.length + 1 + index),
      );
    });
  });

  describe('revision variant checks', () => {
    it('refuses an empty, repeated, unknown or oversized variant list', () => {
      const product = configurableWith(2);
      expect(submit(product, { revisionId: rev(1), revisionVariantIds: [] })).toEqual({
        ok: false,
        error: { code: 'variant.none' },
      });
      expect(submit(product, { revisionId: rev(1), revisionVariantIds: [v(1), v(1)] })).toEqual({
        ok: false,
        error: { code: 'variant.unknown' },
      });
      expect(submit(product, { revisionId: rev(1), revisionVariantIds: [v(9)] })).toEqual({
        ok: false,
        error: { code: 'variant.unknown' },
      });
      expect(submit(product, { revisionId: rev(1), maxVariants: 1 })).toEqual({
        ok: false,
        error: { code: 'variant.limit-reached', max: 1 },
      });
    });

    it('requires a Simple product to name its one variant exactly', () => {
      const product = simple();
      expect(submit(product, { revisionId: rev(1), revisionVariantIds: [] }).ok).toBe(false);
    });
  });

  describe('author and scope', () => {
    it('refuses a seller on a PLATFORM product and an admin on a SELLER product', () => {
      expect(submit(simple('PLATFORM'), { revisionId: rev(1) })).toEqual({
        ok: false,
        error: { code: 'product.platform-admin-only' },
      });
      expect(submit(simple(), { revisionId: rev(1), authorKind: 'admin' })).toEqual({
        ok: false,
        error: { code: 'product.seller-only' },
      });
    });

    it('lets an admin publish a PLATFORM product', () => {
      const product = simple('PLATFORM');
      const result = submit(product, { revisionId: rev(1), authorKind: 'admin' });
      expect(result.ok).toBe(true);
      expect(product.state.status).toBe('published');
    });

    it('refuses a revision on a product that is no longer editable', () => {
      const product = simple();
      product.discard(T1);
      expect(submit(product, { revisionId: rev(1) })).toEqual({
        ok: false,
        error: { code: 'product.not-editable' },
      });
    });
  });
});

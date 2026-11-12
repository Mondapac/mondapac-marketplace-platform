import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Product, revertTypeRefusal } from './product';
import type { RevisionOutcome } from './product-revision-policy';
import { configurableProductType } from './product-types/configurable';
import { simpleProductType } from './product-types/simple';

// Add sizes on the aggregate (catalog design 4.2a, M-9; variants V9), on both Market fixtures. The
// database side (trigger, cascade) is in test/db/catalog-product-add-sizes.db-spec.ts.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-06T01:00:00Z');
const T2 = Temporal.Instant.from('2026-11-06T02:00:00Z');
const productId = 'p1' as Id<'Product'>;
const seller = 's1' as Id<'Seller'>;
const variant = 'v1' as Id<'Variant'>;
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
  reasons: ['approval-required'],
};

describe.each(['AU', 'ZZ'] as const)('Add sizes in market %s', (market) => {
  function simple(scope: 'SELLER' | 'PLATFORM' = 'SELLER', familyCode = 'default'): Product {
    const created = Product.create({
      id: productId,
      marketId: market as MarketId,
      scope,
      sellerId: scope === 'SELLER' ? seller : null,
      handler: simpleProductType,
      familyCode,
      productCode: 'P00000001',
      variantId: variant,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  /** A stored copy of the product as a later unit reads it, with the events of the first one gone. */
  const reread = (product: Product): Product => Product.restore(product.state);

  const publish = (
    product: Product,
    revisionId: Id<'ProductRevision'>,
    outcome: RevisionOutcome = PUBLISHED,
  ) =>
    product.submitRevision({
      revisionId,
      baseRevisionId: product.state.publishedRevisionId,
      outcome,
      authorKind: product.state.scope === 'SELLER' ? 'seller' : 'admin',
      familyCode: product.state.familyCode,
      replacePending: false,
      revisionVariantIds: product.liveVariants.map((live) => live.id),
      maxVariants: 100,
      now: T1,
    });

  const add = (
    product: Product,
    input: Partial<Parameters<Product['addSizes']>[0]> = {},
  ): ReturnType<Product['addSizes']> =>
    product.addSizes({
      authorKind: product.state.scope === 'SELLER' ? 'seller' : 'admin',
      replacePending: false,
      revertFamilyCode: 'default',
      now: T2,
      ...input,
    });

  it('turns a Simple product into a Configurable one and keeps the variant as it was', () => {
    const product = reread(simple());
    const before = product.state.variants[0]!;
    const result = add(product);

    expect(result).toEqual({ ok: true, value: { variantId: variant, supersededRevisionId: null } });
    expect(product.state).toMatchObject({
      typeCode: configurableProductType.typeCode,
      variantModel: configurableProductType.variantModel,
      status: 'draft',
      version: 2,
    });
    // Price and stock key on the variant id, and the number is the code's: both stay.
    expect(product.state.variants).toEqual([before]);
    expect(product.state.variants[0]).toMatchObject({
      id: variant,
      variantNo: 1,
      state: 'proposed',
    });
    expect(product.liveVariants.map((live) => live.id)).toEqual([variant]);
  });

  it('keeps the id and number of a published variant and announces no variant event', () => {
    const product = simple();
    publish(product, rev(1));
    const stored = reread(product);
    const result = add(stored);

    expect(result.ok).toBe(true);
    expect(stored.state.variants[0]).toMatchObject({
      id: variant,
      variantNo: 1,
      state: 'published',
    });
    expect(stored.pendingEvents.map((event) => event.type)).toEqual([
      'catalog.product-type-changed.v1',
    ]);
    expect(stored.pendingEvents[0]).toMatchObject({
      aggregateVersion: product.state.version + 1,
      payload: {
        productId,
        scope: 'seller',
        fromTypeCode: 'simple',
        toTypeCode: 'configurable',
        variantId: variant,
        publishedRevisionId: rev(1),
      },
    });
    // The published pointer, the family and the status are not touched: nothing is published.
    expect(stored.state).toMatchObject({
      publishedRevisionId: rev(1),
      status: 'published',
      familyCode: 'default',
    });
  });

  it('names no published revision for a product that was never published, and scope platform', () => {
    const product = reread(simple('PLATFORM'));
    expect(add(product).ok).toBe(true);
    expect(product.pendingEvents[0]).toMatchObject({
      payload: { scope: 'platform', publishedRevisionId: null },
    });
  });

  it('refuses a product that is not Simple, so a Configurable one never changes again', () => {
    const product = reread(simple());
    expect(add(product).ok).toBe(true);
    const again = reread(Product.restore(product.state));
    expect(add(again)).toEqual({ ok: false, error: { code: 'product.not-simple' } });
    expect(again.state).toEqual(product.state);
    expect(again.pendingEvents).toEqual([]);

    const created = Product.create({
      id: productId,
      marketId: market as MarketId,
      scope: 'SELLER',
      sellerId: seller,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: 'P00000002',
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    expect(add(created.value)).toEqual({ ok: false, error: { code: 'product.not-simple' } });
  });

  it('has no way back to Simple: the only type command moves simple to configurable', () => {
    const product = reread(simple());
    add(product);
    expect(product.state.typeCode).toBe('configurable');
    expect(
      (product as unknown as Record<string, unknown>)['removeSizes'] ??
        (product as unknown as Record<string, unknown>)['makeSimple'],
    ).toBeUndefined();
    // A revert to a revision frozen as Simple is refused while the product is Configurable.
    expect(revertTypeRefusal('configurable', 'simple')).toEqual({
      code: 'revision.revert-changes-type',
    });
    expect(revertTypeRefusal('configurable', 'configurable')).toBeNull();
    expect(revertTypeRefusal('simple', 'simple')).toBeNull();
  });

  it('applies the author rule and the editable statuses first', () => {
    expect(add(reread(simple('PLATFORM')), { authorKind: 'seller' })).toEqual({
      ok: false,
      error: { code: 'product.platform-admin-only' },
    });
    expect(add(reread(simple('SELLER')), { authorKind: 'admin' })).toEqual({
      ok: false,
      error: { code: 'product.seller-only' },
    });
    const discarded = reread(simple());
    expect(discarded.discard(T1).ok).toBe(true);
    expect(add(reread(Product.restore(discarded.state)))).toEqual({
      ok: false,
      error: { code: 'product.not-editable' },
    });
    // A paused product can still change type (design 4.2a).
    const paused = simple('PLATFORM');
    publish(paused, rev(1));
    const pausedStored = reread(paused);
    expect(pausedStored.pause({ accountId: 'a1' as Id<'Account'>, now: T1 }).ok).toBe(true);
    expect(add(reread(Product.restore(pausedStored.state))).ok).toBe(true);
  });

  it('answers not-simple before the pending guard', () => {
    const product = simple();
    add(product);
    publish(Product.restore(product.state), rev(1));
    expect(add(product, { replacePending: false })).toEqual({
      ok: false,
      error: { code: 'product.not-simple' },
    });
  });

  describe('a pending revision', () => {
    function withPending(): Product {
      const product = simple();
      publish(product, rev(1));
      const stored = reread(product);
      expect(publish(stored, rev(2), PENDING).ok).toBe(true);
      return reread(stored);
    }

    it('is refused without replacePending and nothing changes', () => {
      const product = withPending();
      const before = product.state;
      expect(add(product)).toEqual({ ok: false, error: { code: 'revision.pending-exists' } });
      expect(product.state).toEqual(before);
      expect(product.pendingEvents).toEqual([]);
    });

    it('is set aside with replacePending, and the family goes back to the published one', () => {
      const product = withPending();
      // The pending revision moved the family to "other"; the published revision's was "default".
      const moved = Product.restore({ ...product.state, familyCode: 'other' });
      const result = add(moved, { replacePending: true, revertFamilyCode: 'default' });

      expect(result).toEqual({
        ok: true,
        value: { variantId: variant, supersededRevisionId: rev(2) },
      });
      expect(moved.state).toMatchObject({
        typeCode: 'configurable',
        variantModel: 'options',
        publishedRevisionId: rev(1),
        pendingRevisionId: null,
        pendingSubmittedAt: null,
        familyCode: 'default',
      });
      expect(moved.pendingEvents.map((event) => event.type)).toEqual([
        'catalog.product-type-changed.v1',
        'catalog.product-family-changed.v1',
      ]);
      expect(moved.pendingEvents[1]).toMatchObject({
        payload: { productId, revisionId: rev(2), scope: 'seller' },
      });
      // One version per event, in order (Q-K3).
      expect(moved.pendingEvents.map((event) => event.aggregateVersion)).toEqual([
        moved.persistedVersion! + 1,
        moved.persistedVersion! + 2,
      ]);
      expect(moved.state.version).toBe(moved.persistedVersion! + 2);
    });

    it('records no family event when the family was already the published one', () => {
      const product = withPending();
      expect(add(product, { replacePending: true }).ok).toBe(true);
      expect(product.pendingEvents.map((event) => event.type)).toEqual([
        'catalog.product-type-changed.v1',
      ]);
      expect(product.state.pendingRevisionId).toBeNull();
    });

    it('refuses a family code that is not a code', () => {
      const product = withPending();
      expect(add(product, { replacePending: true, revertFamilyCode: 'Not A Code' })).toEqual({
        ok: false,
        error: { code: 'product.family-invalid' },
      });
      expect(product.state.typeCode).toBe('simple');
    });
  });

  it('lets the next submit freeze a Configurable revision: the event names the revision type', () => {
    const product = reread(simple());
    add(product);
    const stored = reread(product);
    const submitted = publish(stored, rev(1));
    expect(submitted.ok).toBe(true);
    expect(
      stored.pendingEvents.find((e) => e.type === 'catalog.product-revision-published.v1'),
    ).toMatchObject({ payload: { revisionId: rev(1), typeCode: 'configurable' } });
  });

  it('publishes an approval or a tax override with the revision type, not the row type', () => {
    const pending = simple();
    expect(publish(pending, rev(1), PENDING).ok).toBe(true);
    const approving = reread(pending);
    // The row changed type after the revision was frozen (Add sizes keeps no pending, so this is
    // the guard against reading the wrong one): the event names the revision's own type.
    const row = Product.restore({
      ...approving.state,
      typeCode: 'configurable',
      variantModel: 'options',
    });
    expect(
      row.approveRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        revisionTypeCode: 'simple',
        revisionVariantIds: [variant],
        maxVariants: 100,
        now: T2,
      }).ok,
    ).toBe(true);
    expect(
      row.pendingEvents.find((e) => e.type === 'catalog.product-revision-published.v1'),
    ).toMatchObject({ payload: { typeCode: 'simple' } });

    const published = simple();
    publish(published, rev(1));
    const overriding = Product.restore({
      ...published.state,
      typeCode: 'configurable',
      variantModel: 'options',
    });
    expect(
      overriding.publishTaxOverride({
        revisionId: rev(2),
        fromRevisionId: rev(1),
        revisionTypeCode: 'simple',
        now: T2,
      }).ok,
    ).toBe(true);
    expect(
      overriding.pendingEvents.find((e) => e.type === 'catalog.product-revision-published.v1'),
    ).toMatchObject({ payload: { revisionId: rev(2), typeCode: 'simple' } });
  });

  it('refuses a type outside the event vocabulary instead of publishing it silently', () => {
    const product = simple();
    expect(() =>
      Product.restore({ ...product.state, typeCode: 'garment' }).submitRevision({
        revisionId: rev(1),
        baseRevisionId: null,
        outcome: PUBLISHED,
        authorKind: 'seller',
        familyCode: 'default',
        replacePending: false,
        revisionVariantIds: [variant],
        maxVariants: 100,
        now: T1,
      }),
    ).toThrow(RangeError);
  });
});

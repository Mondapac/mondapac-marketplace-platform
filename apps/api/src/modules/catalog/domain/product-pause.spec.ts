import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Product, type ProductState } from './product';
import { simpleProductType } from './product-types/simple';

// The admin pause, withdraw and retire of a product (catalog design 4.1, 4.1a), in the AU market
// and a synthetic one: the domain is Market-agnostic.
const FIXTURE_MARKETS = [{ code: 'AU' }, { code: 'ZZ' }] as const;
const T0 = Temporal.Instant.from('2026-10-30T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-30T01:00:00Z');
const productId = 'p1' as Id<'Product'>;
const seller = 's1' as Id<'Seller'>;
const admin = 'a1' as Id<'Account'>;

function product(
  marketId: MarketId,
  scope: 'SELLER' | 'PLATFORM',
  status: ProductState['status'],
  extra: Partial<ProductState> = {},
): Product {
  const created = Product.create({
    id: productId,
    marketId,
    scope,
    sellerId: scope === 'SELLER' ? seller : null,
    handler: simpleProductType,
    familyCode: 'default',
    productCode: 'P00000001',
    variantId: 'v1' as Id<'Variant'>,
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return Product.restore({
    ...created.value.state,
    status,
    publishedRevisionId: status === 'draft' ? null : ('r1' as Id<'ProductRevision'>),
    ...extra,
  });
}

describe.each(FIXTURE_MARKETS)('product pause, withdraw and retire in market $code', ({ code }) => {
  const market = code as MarketId;

  describe('pause and resume', () => {
    it('pauses a published product: mark, account, one event, version raised by one', () => {
      const p = product(market, 'SELLER', 'published');
      const before = p.state.version;

      expect(p.pause({ accountId: admin, now: T1 })).toEqual({ ok: true, value: undefined });

      expect(p.state).toMatchObject({
        status: 'published',
        pausedAt: T1,
        pausedByAccountId: admin,
        version: before + 1,
      });
      expect(p.pendingEvents.map((event) => event.type)).toEqual(['catalog.product-paused.v1']);
      expect(p.pendingEvents[0]).toMatchObject({ aggregateId: productId, payload: { productId } });
    });

    it.each(['draft', 'unpublished', 'withdrawn', 'retired', 'matched'] as const)(
      'refuses to pause a %s product',
      (status) => {
        const p = product(market, 'SELLER', status);

        expect(p.pause({ accountId: admin, now: T1 })).toEqual({
          ok: false,
          error: { code: 'product.not-published' },
        });
        expect(p.pendingEvents).toEqual([]);
      },
    );

    it('refuses a second pause and changes nothing', () => {
      const p = product(market, 'PLATFORM', 'published', {
        pausedAt: T0,
        pausedByAccountId: admin,
      });
      const before = p.state;

      expect(p.pause({ accountId: admin, now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.already-paused' },
      });
      expect(p.state).toEqual(before);
    });

    it('resumes a paused product: the mark clears, one event', () => {
      const p = product(market, 'SELLER', 'published', { pausedAt: T0, pausedByAccountId: admin });

      expect(p.resume({ now: T1 })).toEqual({ ok: true, value: undefined });

      expect(p.state).toMatchObject({
        status: 'published',
        pausedAt: null,
        pausedByAccountId: null,
      });
      expect(p.pendingEvents.map((event) => event.type)).toEqual(['catalog.product-resumed.v1']);
    });

    it('refuses to resume a product that is not paused', () => {
      const p = product(market, 'SELLER', 'published');

      expect(p.resume({ now: T1 })).toEqual({ ok: false, error: { code: 'product.not-paused' } });
      expect(p.pendingEvents).toEqual([]);
    });
  });

  describe('withdraw (SELLER products)', () => {
    it.each(['unpublished', 'published'] as const)(
      'withdraws a %s product, terminally',
      (status) => {
        const p = product(market, 'SELLER', status, {
          pendingRevisionId: 'r2' as Id<'ProductRevision'>,
          pendingSubmittedAt: T0,
        });

        expect(p.withdraw({ now: T1 })).toEqual({ ok: true, value: undefined });

        expect(p.state).toMatchObject({
          status: 'withdrawn',
          withdrawnAt: T1,
          pendingRevisionId: null,
          pendingSubmittedAt: null,
        });
        expect(p.pendingEvents.map((event) => event.type)).toEqual([
          'catalog.product-withdrawn.v1',
        ]);
        // Terminal: nothing leaves withdrawn.
        expect(p.pause({ accountId: admin, now: T1 }).ok).toBe(false);
        expect(p.withdraw({ now: T1 })).toEqual({
          ok: false,
          error: { code: 'product.not-withdrawable' },
        });
      },
    );

    it('withdraws a paused product and clears the pause mark', () => {
      const p = product(market, 'SELLER', 'published', { pausedAt: T0, pausedByAccountId: admin });

      expect(p.withdraw({ now: T1 }).ok).toBe(true);

      expect(p.state).toMatchObject({
        status: 'withdrawn',
        pausedAt: null,
        pausedByAccountId: null,
      });
    });

    it('refuses a PLATFORM product and a draft', () => {
      expect(product(market, 'PLATFORM', 'published').withdraw({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.seller-only' },
      });
      expect(product(market, 'SELLER', 'draft').withdraw({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.not-withdrawable' },
      });
    });
  });

  describe('retire (PLATFORM products)', () => {
    it('retires a published product, terminally', () => {
      const p = product(market, 'PLATFORM', 'published');

      expect(p.retire({ now: T1 })).toEqual({ ok: true, value: undefined });

      expect(p.state).toMatchObject({ status: 'retired', retiredAt: T1, pausedAt: null });
      expect(p.pendingEvents.map((event) => event.type)).toEqual(['catalog.product-retired.v1']);
      expect(p.retire({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.not-published' },
      });
    });

    it('retires a paused product and clears the pause mark', () => {
      const p = product(market, 'PLATFORM', 'published', {
        pausedAt: T0,
        pausedByAccountId: admin,
      });

      expect(p.retire({ now: T1 }).ok).toBe(true);

      expect(p.state).toMatchObject({ status: 'retired', pausedAt: null, pausedByAccountId: null });
    });

    it('refuses a SELLER product and a product that is not published', () => {
      expect(product(market, 'SELLER', 'published').retire({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.platform-only' },
      });
      expect(product(market, 'PLATFORM', 'unpublished').retire({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'product.not-published' },
      });
    });
  });
});

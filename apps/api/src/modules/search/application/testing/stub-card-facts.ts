import type { Id } from '@mondapac/shared-kernel';
import type { CardFactSource } from '../card-facts';
import {
  detailKeyOf,
  type DetailBadge,
  type DetailSeller,
  type DetailStock,
} from '../ports/product-detail-sources';

/**
 * A {@link CardFactSource} for tests: answers what it is given (nothing by default), records the
 * calls, and fails a source on demand (`null`, as the facade adapter does).
 */
export class StubCardFacts implements CardFactSource {
  readonly sellerNames = new Map<Id<'Seller'>, DetailSeller>();
  readonly stock = new Map<string, DetailStock>();
  readonly offerBadges = new Map<Id<'Offer'>, readonly DetailBadge[]>();
  readonly failing = new Set<'sellers' | 'availability' | 'badges'>();
  readonly badgeCalls: (readonly Id<'Offer'>[])[] = [];
  readonly stockCalls: (readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[])[] = [];

  setStock(offerId: Id<'Offer'>, variantId: Id<'Variant'>, stock: DetailStock): void {
    this.stock.set(detailKeyOf({ offerId, variantId }), stock);
  }

  sellers(
    _context: unknown,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, DetailSeller> | null> {
    if (this.failing.has('sellers')) return Promise.resolve(null);
    const out = new Map<Id<'Seller'>, DetailSeller>();
    for (const id of sellerIds) {
      const found = this.sellerNames.get(id);
      if (found !== undefined) out.set(id, found);
    }
    return Promise.resolve(out);
  }

  availability(
    _context: unknown,
    keys: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[],
  ): Promise<ReadonlyMap<string, DetailStock> | null> {
    this.stockCalls.push(keys);
    if (this.failing.has('availability')) return Promise.resolve(null);
    const out = new Map<string, DetailStock>();
    for (const key of keys) {
      const found = this.stock.get(detailKeyOf(key));
      if (found !== undefined) out.set(detailKeyOf(key), found);
    }
    return Promise.resolve(out);
  }

  badges(
    _context: unknown,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, readonly DetailBadge[]> | null> {
    this.badgeCalls.push(offerIds);
    if (this.failing.has('badges')) return Promise.resolve(null);
    const out = new Map<Id<'Offer'>, readonly DetailBadge[]>();
    for (const id of offerIds) {
      const found = this.offerBadges.get(id);
      if (found !== undefined) out.set(id, found);
    }
    return Promise.resolve(out);
  }
}

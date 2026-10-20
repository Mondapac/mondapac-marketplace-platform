import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { InventoryFacade } from '../../inventory';
import type { PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import {
  detailKeyOf,
  type DetailKey,
  type DetailPrice,
  type DetailProduct,
  type DetailSeller,
  type DetailStock,
  type ProductDetailSources,
} from '../application/ports/product-detail-sources';

/**
 * {@link ProductDetailSources} over the facades of catalog, pricing, inventory and sellers, each
 * called with the request's context unchanged. Any refusal or failure is `null`: the caller fails
 * closed. Inventory's exact `sellable` count is read nowhere: only `status` and `onlyLeft` pass.
 */
export class FacadeProductDetailSources implements ProductDetailSources {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly pricing: PricingFacade,
    private readonly inventory: InventoryFacade,
    private readonly sellersFacade: SellersFacade,
  ) {}

  async product(
    context: CallContext,
    productId: Id<'Product'>,
    locale: string,
  ): Promise<{ readonly product: DetailProduct | null } | null> {
    try {
      const result = await this.catalog.publishedProduct(context, productId, locale);
      if (!result.ok) return null;
      const published = result.value;
      if (published === null) return { product: null };
      return {
        product: {
          name: published.name,
          shortDescription: published.shortDescription,
          description: published.description,
          categoryIds: published.categoryIds,
          variants: published.variants.map(({ variantId, label }) => ({ variantId, label })),
        },
      };
    } catch {
      return null;
    }
  }

  async prices(
    context: CallContext,
    keys: readonly DetailKey[],
  ): Promise<ReadonlyMap<string, DetailPrice> | null> {
    if (keys.length === 0) return new Map();
    try {
      const result = await this.pricing.effectivePrices(context, keys);
      if (!result.ok) return null;
      const prices = new Map<string, DetailPrice>();
      for (const key of keys) {
        const found = result.value.get(`${key.offerId}/${key.variantId}`);
        if (found === undefined) continue;
        prices.set(detailKeyOf(key), {
          price: found.price,
          taxInclusive: found.taxInclusive,
          special:
            found.basis === 'special' && found.specialEndsAt !== null
              ? { endsAt: found.specialEndsAt }
              : null,
        });
      }
      return prices;
    } catch {
      return null;
    }
  }

  async availability(
    context: CallContext,
    keys: readonly DetailKey[],
  ): Promise<ReadonlyMap<string, DetailStock> | null> {
    if (keys.length === 0) return new Map();
    try {
      const result = await this.inventory.availability(context, keys);
      if (!result.ok) return null;
      const stock = new Map<string, DetailStock>();
      for (const key of keys) {
        const found = result.value.get(`${key.offerId}/${key.variantId}`);
        if (found === undefined) continue;
        stock.set(detailKeyOf(key), { status: found.status, onlyLeft: found.onlyLeft });
      }
      return stock;
    } catch {
      return null;
    }
  }

  async sellers(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, DetailSeller> | null> {
    if (sellerIds.length === 0) return new Map();
    try {
      const result = await this.sellersFacade.sellerSummaries(context, [...new Set(sellerIds)]);
      if (!result.ok) return null;
      const sellers = new Map<Id<'Seller'>, DetailSeller>();
      for (const summary of result.value) {
        sellers.set(summary.sellerId, {
          storeName: summary.storeName,
          ...('minimumOrder' in summary ? { minimumOrder: summary.minimumOrder ?? null } : {}),
        });
      }
      return sellers;
    } catch {
      return null;
    }
  }
}

import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { ProductImages, PublicImage } from '../application/ports/product-images';

/**
 * {@link ProductImages} over catalog's `publishedProductImages` (published revision only, taken
 * down photos skipped), with the request's context unchanged. At most 200 products per call. Any
 * refusal or failure is `null`: the caller shows no photo.
 */
export class FacadeProductImages implements ProductImages {
  constructor(private readonly catalog: CatalogFacade) {}

  async of(
    context: CallContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, readonly PublicImage[]> | null> {
    if (productIds.length === 0) return new Map();
    try {
      const result = await this.catalog.publishedProductImages(context, productIds);
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }
}

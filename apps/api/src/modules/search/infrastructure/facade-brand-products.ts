import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { BrandProducts } from '../application/ports/brand-products';

/**
 * {@link BrandProducts} over catalog's `brandProductIds` (rule `anonymous`), with the request's
 * context unchanged. Any refusal or failure is `null`.
 */
export class FacadeBrandProducts implements BrandProducts {
  constructor(private readonly catalog: CatalogFacade) {}

  async productIdsOf(
    context: CallContext,
    slug: string,
  ): Promise<{
    readonly productIds: readonly Id<'Product'>[];
    readonly truncated: boolean;
  } | null> {
    try {
      const result = await this.catalog.brandProductIds(context, slug);
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }
}

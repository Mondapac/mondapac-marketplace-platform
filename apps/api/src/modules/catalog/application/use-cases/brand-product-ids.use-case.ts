import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_BRAND_PRODUCT_IDS,
  type BrandProductIds,
  type CatalogValidationFailed,
} from '../../contracts/catalog.facade';
import { isBrandSlug } from '../../domain/brand';
import type { BrandReader } from '../ports/brand.reader';

export interface BrandProductIdsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `catalog.brand-product-ids`: the ids of the live products of an active brand in the request's
 * Market, for `search` to list a brand page's products. Rule `anonymous`; ids only. A product is
 * live by the same rule as the brand page's count (published, with an Offer on sale). A slug that
 * is malformed, unknown, a draft or archived brand is one empty answer. Reads one more than
 * {@link MAX_BRAND_PRODUCT_IDS} to say whether the list was cut. One read-only unit.
 */
export class BrandProductIdsQuery extends UseCase<
  { readonly slug: string },
  BrandProductIds,
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-product-ids',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandProductIdsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly slug: string },
  ): Promise<Result<BrandProductIds, CatalogValidationFailed>> {
    if (!isBrandSlug(input?.slug)) return ok({ productIds: [], truncated: false });
    const { market } = context;
    return this.deps.unitOfWork.run<BrandProductIds, CatalogValidationFailed>(
      market,
      async () => {
        const ids = await this.deps.brandReader.liveProductIds(
          market,
          input.slug,
          MAX_BRAND_PRODUCT_IDS + 1,
        );
        return ok({
          productIds: ids.slice(0, MAX_BRAND_PRODUCT_IDS),
          truncated: ids.length > MAX_BRAND_PRODUCT_IDS,
        });
      },
      { readOnly: true },
    );
  }
}

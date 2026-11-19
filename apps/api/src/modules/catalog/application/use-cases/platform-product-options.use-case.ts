import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogMarketPolicy, TaxCategoryOption } from '../ports/catalog-market-policy';
import type { OwnCatalogReader, ProductFormCategory } from '../ports/own-catalog.reader';

export interface PlatformProductOptionsOutput {
  /** The product types the Market offers, in the Market's order. */
  readonly productTypes: readonly string[];
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  /** The Market's tax categories, as the product read lists them. */
  readonly taxCategoryCodes: readonly string[];
  /** The same categories with the label key each is shown by. */
  readonly taxCategories: readonly TaxCategoryOption[];
  /** The active platform categories, in the shape of `form.categories` of the product read. */
  readonly categories: readonly ProductFormCategory[];
}

export type PlatformProductOptionsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface PlatformProductOptionsDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
}

/**
 * `platform-product.options` (catalog design 8.2): what the admin panel's Add page offers: the Market configuration (types, locales, tax
 * categories) and the active platform categories (one read-only unit). Rule: the key
 * `catalog.platform-product.edit`, as the form that uses it.
 */
export class PlatformProductOptions extends UseCase<
  Record<string, never>,
  PlatformProductOptionsOutput,
  PlatformProductOptionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-options',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductOptionsDependencies,
  ) {
    super(gate);
  }

  readonly #logger = new Logger('PlatformProductOptions');

  protected async handle(
    context: CallContext,
  ): Promise<Result<PlatformProductOptionsOutput, PlatformProductOptionsFailure>> {
    const { market } = context;
    let productTypes: readonly string[];
    let taxCategoryCodes: readonly string[];
    let taxCategories: readonly TaxCategoryOption[];
    let locales: { default: string; supported: readonly string[] };
    try {
      const configured = this.deps.policy.locales(market);
      locales = { default: configured.default, supported: [...configured.supported] };
      productTypes = [...this.deps.policy.productTypes(market)];
      taxCategoryCodes = [...this.deps.policy.taxCategoryCodes(market)];
      taxCategories = this.deps.policy.taxCategories(market).map((category) => ({ ...category }));
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // The category list does not depend on a product or its family: the Add page needs it before
    // the product exists.
    const read = await this.deps.unitOfWork
      .run(market, async () => ok(await this.deps.ownReader.productCategories(market)), {
        readOnly: true,
      })
      .catch(() => ({ ok: false as const }));
    // A failed category read degrades to an empty list: the other answers stay usable.
    if (!read.ok) {
      this.#logger.warn({
        msg: 'catalog.platform-product-options.categories-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return ok({
      productTypes,
      locales,
      taxCategoryCodes,
      taxCategories,
      categories: read.ok ? read.value : [],
    });
  }
}

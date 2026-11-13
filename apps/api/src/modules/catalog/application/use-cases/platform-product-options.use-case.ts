import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface PlatformProductOptionsOutput {
  /** The product types the Market offers, in the Market's order. */
  readonly productTypes: readonly string[];
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export type PlatformProductOptionsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface PlatformProductOptionsDependencies {
  readonly policy: CatalogMarketPolicy;
}

/**
 * `platform-product.options` (catalog design 8.2): what the admin panel's create form offers,
 * from the Market configuration. Opens no unit of its own. Rule: the key
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

  protected handle(
    context: CallContext,
  ): Promise<Result<PlatformProductOptionsOutput, PlatformProductOptionsFailure>> {
    const { market } = context;
    try {
      const locales = this.deps.policy.locales(market);
      return Promise.resolve(
        ok({
          productTypes: [...this.deps.policy.productTypes(market)],
          locales: { default: locales.default, supported: [...locales.supported] },
        }),
      );
    } catch {
      return Promise.resolve(err({ code: 'access.unavailable' }));
    }
  }
}

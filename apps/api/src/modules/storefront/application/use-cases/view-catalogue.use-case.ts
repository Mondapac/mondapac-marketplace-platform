import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_READ } from '../../contracts/permissions';
import { type CatalogueView, type PageFailure, viewCatalogue } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-catalogue`: An admin reads the templates, their slots, the module catalogue and the system pages. */
export class ViewStorefrontCatalogue extends UseCase<
  Record<string, never>,
  CatalogueView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-catalogue',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return Promise.resolve(viewCatalogue(context));
  }
}

export type { CatalogueView };

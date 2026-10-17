import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, reorderModules } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.reorder-modules`: An admin puts the modules of a slot of a page's draft in a new order. */
export class ReorderStorefrontModules extends UseCase<
  Parameters<typeof reorderModules>[2],
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.reorder-modules',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Parameters<typeof reorderModules>[2]) {
    return reorderModules(this.deps, context, input);
  }
}

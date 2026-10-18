import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, removeModule } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.remove-module`: An admin removes a module from a page's draft. */
export class RemoveStorefrontModule extends UseCase<
  Parameters<typeof removeModule>[2],
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.remove-module',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Parameters<typeof removeModule>[2]) {
    return removeModule(this.deps, context, input);
  }
}

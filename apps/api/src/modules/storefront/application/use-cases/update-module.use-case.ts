import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, updateModule } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.update-module`: An admin changes a module's settings in a page's draft, or switches it on or off. */
export class UpdateStorefrontModule extends UseCase<
  Parameters<typeof updateModule>[2],
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.update-module',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Parameters<typeof updateModule>[2]) {
    return updateModule(this.deps, context, input);
  }
}

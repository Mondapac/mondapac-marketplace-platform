import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, addModule } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.add-module`: An admin adds a module to a slot of a page's draft. */
export class AddStorefrontModule extends UseCase<
  Parameters<typeof addModule>[2],
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.add-module',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Parameters<typeof addModule>[2]) {
    return addModule(this.deps, context, input);
  }
}

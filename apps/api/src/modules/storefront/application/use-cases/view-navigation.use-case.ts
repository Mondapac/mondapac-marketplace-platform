import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_READ } from '../../contracts/permissions';
import { viewNavigation } from '../navigation-flow';
import type { PageDetailView, PageFailure } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-navigation`: An admin reads the navigation: its draft, the approved version and the versions. */
export class ViewStorefrontNavigation extends UseCase<
  Record<string, never>,
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-navigation',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewNavigation(this.deps, context);
  }
}

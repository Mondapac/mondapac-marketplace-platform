import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_NAVIGATION_APPROVE } from '../../contracts/permissions';
import { approveNavigation } from '../navigation-flow';
import type { PageDetailView, PageFailure } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.approve-navigation`: A platform admin approves the navigation draft, so buyers see it (protected key). */
export class ApproveStorefrontNavigation extends UseCase<
  { readonly body: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.approve-navigation',
    rule: { kind: 'permissions', allOf: [STOREFRONT_NAVIGATION_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly body: unknown }) {
    return approveNavigation(this.deps, context, input);
  }
}

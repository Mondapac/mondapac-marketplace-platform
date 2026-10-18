import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_NAVIGATION_EDIT } from '../../contracts/permissions';
import { replaceNavigationDraft } from '../navigation-flow';
import type { PageDetailView, PageFailure } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.replace-navigation-draft`: A content editor replaces the navigation draft (left-rail items, Browse drawer categories). */
export class ReplaceStorefrontNavigationDraft extends UseCase<
  unknown,
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.replace-navigation-draft',
    rule: { kind: 'permissions', allOf: [STOREFRONT_NAVIGATION_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return replaceNavigationDraft(this.deps, context, input);
  }
}

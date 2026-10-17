import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_NAVIGATION_EDIT } from '../../contracts/permissions';
import { restoreNavigationVersion } from '../navigation-flow';
import type { PageDetailView, PageFailure } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.restore-navigation-version`: A content editor copies an earlier navigation version into the draft. */
export class RestoreStorefrontNavigationVersion extends UseCase<
  { readonly versionId: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.restore-navigation-version',
    rule: { kind: 'permissions', allOf: [STOREFRONT_NAVIGATION_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly versionId: unknown }) {
    return restoreNavigationVersion(this.deps, context, input);
  }
}

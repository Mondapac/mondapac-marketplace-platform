import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, restoreVersion } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.restore-page-version`: An admin copies an earlier version of a page into its draft. */
export class RestoreStorefrontPageVersion extends UseCase<
  { readonly page: unknown; readonly versionId: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.restore-page-version',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly page: unknown; readonly versionId: unknown },
  ) {
    return restoreVersion(this.deps, context, input);
  }
}

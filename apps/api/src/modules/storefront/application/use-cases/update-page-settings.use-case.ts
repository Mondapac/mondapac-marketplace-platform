import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_EDIT } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, updateSettings } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.update-page-settings`: An admin changes a page's settings (title, slug, SEO, linked entity, live window). */
export class UpdateStorefrontPageSettings extends UseCase<
  { readonly page: unknown; readonly body: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.update-page-settings',
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
    input: { readonly page: unknown; readonly body: unknown },
  ) {
    return updateSettings(this.deps, context, input);
  }
}

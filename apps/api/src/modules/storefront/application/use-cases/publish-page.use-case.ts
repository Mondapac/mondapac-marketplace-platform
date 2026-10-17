import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_PUBLISH } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, publishPage } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.publish-page`: A platform admin publishes a page's draft (protected key). */
export class PublishStorefrontPage extends UseCase<
  { readonly page: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.publish-page',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly page: unknown }) {
    return publishPage(this.deps, context, input);
  }
}

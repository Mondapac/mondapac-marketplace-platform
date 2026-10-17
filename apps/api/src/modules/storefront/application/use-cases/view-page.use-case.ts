import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_READ } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, viewPage } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-page`: An admin reads a page: settings, slots, draft, published version and versions. */
export class ViewStorefrontPage extends UseCase<
  { readonly page: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-page',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly page: unknown }) {
    return viewPage(this.deps, context, input);
  }
}

export type { PageDetailView };

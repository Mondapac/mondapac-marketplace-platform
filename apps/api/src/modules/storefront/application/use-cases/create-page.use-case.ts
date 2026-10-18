import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_CREATE } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, createPage } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.create-page`: An admin creates a dynamic page from a template. */
export class CreateStorefrontPage extends UseCase<unknown, PageDetailView, PageFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.create-page',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_CREATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return createPage(this.deps, context, input);
  }
}

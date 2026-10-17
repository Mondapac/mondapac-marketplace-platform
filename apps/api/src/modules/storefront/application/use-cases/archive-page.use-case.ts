import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_ARCHIVE } from '../../contracts/permissions';
import { type PageDetailView, type PageFailure, archivePage } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.archive-page`: A platform admin archives a dynamic page (protected key). */
export class ArchiveStorefrontPage extends UseCase<
  { readonly page: unknown; readonly body: unknown },
  PageDetailView,
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.archive-page',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_ARCHIVE.key] },
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
    return archivePage(this.deps, context, input);
  }
}

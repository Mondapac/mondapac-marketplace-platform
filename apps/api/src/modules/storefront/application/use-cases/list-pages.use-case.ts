import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_READ } from '../../contracts/permissions';
import { type PageFailure, type PageSummaryView, listPages } from '../page-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.list-pages`: An admin reads every system and dynamic page of the Market. */
export class ListStorefrontPages extends UseCase<
  Record<string, never>,
  readonly PageSummaryView[],
  PageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.list-pages',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listPages(this.deps, context);
  }
}

export type { PageSummaryView };

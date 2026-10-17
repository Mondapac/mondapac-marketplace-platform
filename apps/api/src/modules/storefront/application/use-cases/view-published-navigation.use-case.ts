import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { type PublicFailure, type PublishedAnswer, viewPublishedSystemPage } from '../public-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-published-navigation`: A buyer with no session reads the approved navigation (or the empty default). */
export class ViewPublishedStorefrontNavigation extends UseCase<
  Record<string, never>,
  PublishedAnswer,
  PublicFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-published-navigation',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewPublishedSystemPage(this.deps, context, { key: null }, true);
  }
}

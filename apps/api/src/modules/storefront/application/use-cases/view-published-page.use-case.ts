import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { type PublicFailure, type PublishedAnswer, viewPublishedSystemPage } from '../public-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-published-page`: A buyer with no session reads the published layout of a system page (home, cart, ...). */
export class ViewPublishedStorefrontPage extends UseCase<
  { readonly key: unknown },
  PublishedAnswer,
  PublicFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-published-page',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly key: unknown }) {
    return viewPublishedSystemPage(this.deps, context, input);
  }
}

export type { PublicFailure, PublishedAnswer };

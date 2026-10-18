import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { type PublicFailure, type PublishedAnswer, viewPublishedDynamicPage } from '../public-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-published-landing-page`: A buyer with no session reads a live landing page at /l/<slug>, or where an old slug goes. */
export class ViewPublishedLandingPage extends UseCase<
  { readonly slug: unknown },
  PublishedAnswer,
  PublicFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-published-landing-page',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slug: unknown }) {
    return viewPublishedDynamicPage(this.deps, context, input);
  }
}

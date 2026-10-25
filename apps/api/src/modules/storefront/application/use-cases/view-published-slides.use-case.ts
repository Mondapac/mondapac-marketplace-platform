import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewPublishedSlides,
  type PublicSlidesFailure,
  type PublishedSlide,
  type PublishedSlides,
} from '../public-slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

export type { PublishedSlide, PublishedSlides, PublicSlidesFailure };

/**
 * `storefront.view-published-slides`: A buyer with no session reads the live slides of one slider
 * position for one page: only approved slides inside their window whose link target is alive.
 */
export class ViewPublishedStorefrontSlides extends UseCase<
  unknown,
  PublishedSlides,
  PublicSlidesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-published-slides',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return viewPublishedSlides(this.deps, context, input);
  }
}

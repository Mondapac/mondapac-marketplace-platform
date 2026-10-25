import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_PAUSE } from '../../contracts/permissions';
import { pauseSlide } from '../slide-approval-flow';
import type { SlideDetailView, SlideFailure } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.pause-slide`: An editor pauses an approved slide at once, with no approval. */
export class PauseStorefrontSlide extends UseCase<
  { readonly slide: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.pause-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_PAUSE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return pauseSlide(this.deps, context, input);
  }
}

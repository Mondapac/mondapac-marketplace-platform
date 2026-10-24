import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_READ } from '../../contracts/permissions';
import { type SlideDetailView, type SlideFailure, viewSlide } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.view-slide`: An admin reads a slide of the Market with its draft, live version and versions. */
export class ViewStorefrontSlide extends UseCase<
  { readonly slide: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return viewSlide(this.deps, context, input);
  }
}

export type { SlideDetailView, SlideVersionView } from '../slide-flow';

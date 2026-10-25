import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { type SlideDetailView, type SlideFailure, archiveSlide } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.archive-slide`: An editor archives a slide; it is never served again. */
export class ArchiveStorefrontSlide extends UseCase<
  { readonly slide: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.archive-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return archiveSlide(this.deps, context, input);
  }
}

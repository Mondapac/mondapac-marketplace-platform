import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { submitSlide } from '../slide-approval-flow';
import type { SlideDetailView, SlideFailure } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.submit-slide`: An editor sends the draft of a slide for approval. */
export class SubmitStorefrontSlide extends UseCase<
  { readonly slide: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.submit-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return submitSlide(this.deps, context, input);
  }
}

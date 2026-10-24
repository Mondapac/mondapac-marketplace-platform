import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_PUBLISH } from '../../contracts/permissions';
import { resumeSlide } from '../slide-approval-flow';
import type { SlideDetailView, SlideFailure } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.resume-slide`: A platform admin resumes a paused slide (protected key). */
export class ResumeStorefrontSlide extends UseCase<
  { readonly slide: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.resume-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly slide: unknown }) {
    return resumeSlide(this.deps, context, input);
  }
}

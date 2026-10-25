import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_PUBLISH } from '../../contracts/permissions';
import { approveSlide } from '../slide-approval-flow';
import type { SlideDetailView, SlideFailure } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.approve-slide`: A platform admin approves and publishes a submitted draft (protected key). */
export class ApproveStorefrontSlide extends UseCase<
  { readonly slide: unknown; readonly body: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.approve-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly slide: unknown; readonly body: unknown },
  ) {
    return approveSlide(this.deps, context, input);
  }
}

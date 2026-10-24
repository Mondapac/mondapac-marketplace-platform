import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { type SlideDetailView, type SlideFailure, updateSlideDraft } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.update-slide-draft`: An editor replaces a slide's draft (saved as a new version). */
export class UpdateStorefrontSlideDraft extends UseCase<
  { readonly slide: unknown; readonly body: unknown },
  SlideDetailView,
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.update-slide-draft',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
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
    return updateSlideDraft(this.deps, context, input);
  }
}

import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { type SlideDetailView, type SlideFailure, createSlide } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.create-slide`: An editor creates a slide (a draft) in the Market. */
export class CreateStorefrontSlide extends UseCase<unknown, SlideDetailView, SlideFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.create-slide',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return createSlide(this.deps, context, input);
  }
}

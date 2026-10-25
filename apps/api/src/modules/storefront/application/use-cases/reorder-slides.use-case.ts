import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_EDIT } from '../../contracts/permissions';
import { reorderLiveSlides, type LiveOrderView, type ReorderFailure } from '../slide-order-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

export type { LiveOrderView, ReorderFailure } from '../slide-order-flow';

/**
 * `storefront.reorder-slides`: An editor saves the order of the live slides of one position and
 * scope; it takes effect at once, with no approval.
 */
export class ReorderStorefrontSlides extends UseCase<unknown, LiveOrderView, ReorderFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.reorder-slides',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return reorderLiveSlides(this.deps, context, input);
  }
}

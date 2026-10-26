import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_READ } from '../../contracts/permissions';
import { readSlideOrder, type ReorderFailure, type SlideOrderView } from '../slide-order-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

export type { SlideOrderEntry, SlideOrderView } from '../slide-order-flow';

/**
 * `storefront.view-slide-order`: An admin reads the live slides of one position and scope in the
 * saved order, the list a reorder of that position and scope accepts.
 */
export class ViewStorefrontSlideOrder extends UseCase<unknown, SlideOrderView, ReorderFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.view-slide-order',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return readSlideOrder(this.deps, context, input);
  }
}

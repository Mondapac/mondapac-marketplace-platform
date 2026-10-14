import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_OWN_FEE_VIEW } from '../../contracts/permissions';
import { viewOwnFlatFee, type FlatFeeFailure, type FlatFeeView } from '../flat-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-own-flat-fee`: the acting seller reads its own flat shipping fee. */
export class ViewOwnFlatFee extends UseCase<Record<string, never>, FlatFeeView, FlatFeeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-own-flat-fee',
    rule: { kind: 'permissions', allOf: [SHIPPING_OWN_FEE_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewOwnFlatFee(this.deps, context);
  }
}

import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLAT_FEE_VIEW } from '../../contracts/permissions';
import { viewFlatFee, type FlatFeeFailure, type FlatFeeView } from '../flat-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/** `shipping.view-flat-fee`: an admin reads one seller's flat shipping fee. */
export class ViewFlatFee extends UseCase<
  { readonly sellerId: unknown },
  FlatFeeView,
  FlatFeeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-flat-fee',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLAT_FEE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId: unknown }) {
    return viewFlatFee(this.deps, context, input);
  }
}

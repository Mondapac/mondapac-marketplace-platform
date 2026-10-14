import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_FLAT_FEE_MANAGE } from '../../contracts/permissions';
import { setFlatFee, type FlatFeeFailure, type FlatFeeView } from '../flat-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

interface Input {
  readonly sellerId: unknown;
  readonly amount: unknown;
}

/** `shipping.set-flat-fee`: an admin sets a seller's flat shipping fee (protected key). */
export class SetFlatFee extends UseCase<Input, FlatFeeView, FlatFeeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.set-flat-fee',
    rule: { kind: 'permissions', allOf: [SHIPPING_FLAT_FEE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setFlatFee(this.deps, context, input);
  }
}

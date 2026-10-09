import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  setLineQuantity,
  type CartDependencies,
  type CartFailure,
  type SetQuantityInput,
  type LineWritten,
} from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `set-line-quantity` for a signed-in customer (rule `own-resources`). */
export class SetLineQuantity extends UseCase<SetQuantityInput, LineWritten, CartFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.set-line-quantity',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: SetQuantityInput) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return setLineQuantity(this.deps, context, caller, input);
  }
}

import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  addItem,
  type CartDependencies,
  type CartFailure,
  type AddInput,
  type LineWritten,
} from '../cart-operations';
import { customerCaller } from '../customer-caller';

/** `add-item` for a signed-in customer (rule `own-resources`). */
export class AddItem extends UseCase<AddInput, LineWritten, CartFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.add-item',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: AddInput) {
    const caller = customerCaller(context);
    if (caller === null) return err({ code: 'access.denied' } as const);
    return addItem(this.deps, context, caller, input);
  }
}

import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  createAddress,
  type AddressBookFailure,
  type AddressView,
  type AddressInput,
} from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

export type { AddressView };

/** `customers.create-address`: The customer adds a delivery address (rule `own-resources`). */
export class CreateAddress extends UseCase<AddressInput, AddressView, AddressBookFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.create-address',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AddressInput) {
    return createAddress(this.deps, context, input);
  }
}

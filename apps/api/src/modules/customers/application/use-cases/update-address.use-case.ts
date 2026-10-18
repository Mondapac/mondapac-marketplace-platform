import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  updateAddress,
  type AddressBookFailure,
  type AddressView,
  type AddressInput,
} from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/** `customers.update-address`: The customer changes one of their delivery addresses (rule `own-resources`). */
export class UpdateAddress extends UseCase<
  { readonly addressId: unknown; readonly body: AddressInput },
  AddressView,
  AddressBookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.update-address',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly addressId: unknown; readonly body: AddressInput },
  ) {
    return updateAddress(this.deps, context, input);
  }
}

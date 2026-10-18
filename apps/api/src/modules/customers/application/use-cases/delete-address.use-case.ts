import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { deleteAddress, type AddressBookFailure } from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/** `customers.delete-address`: The customer removes one of their delivery addresses (rule `own-resources`). */
export class DeleteAddress extends UseCase<
  { readonly addressId: unknown },
  { readonly deleted: true },
  AddressBookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.delete-address',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly addressId: unknown }) {
    return deleteAddress(this.deps, context, input);
  }
}

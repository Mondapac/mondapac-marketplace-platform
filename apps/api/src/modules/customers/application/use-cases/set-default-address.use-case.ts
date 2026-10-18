import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  setDefaultAddress,
  type AddressBookFailure,
  type AddressBookView,
} from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/** `customers.set-default-address`: The customer picks their default delivery address (rule `own-resources`). */
export class SetDefaultAddress extends UseCase<
  { readonly addressId: unknown },
  AddressBookView,
  AddressBookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.set-default-address',
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
    return setDefaultAddress(this.deps, context, input);
  }
}

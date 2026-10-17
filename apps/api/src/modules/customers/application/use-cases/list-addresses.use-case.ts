import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { listAddresses, type AddressBookFailure, type AddressBookView } from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

export type { AddressBookView };

/** `customers.list-addresses`: The customer reads their delivery address book (rule `own-resources`). */
export class ListAddresses extends UseCase<
  Record<string, never>,
  AddressBookView,
  AddressBookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.list-addresses',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listAddresses(this.deps, context);
  }
}

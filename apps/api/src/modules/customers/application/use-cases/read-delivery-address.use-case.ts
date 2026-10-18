import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readDeliveryAddress,
  type AddressBookFailure,
  type DeliveryAddressView,
} from '../address-book-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/**
 * `customers.read-delivery-address`: checkout reads one of the signed-in customer's own addresses
 * to copy it onto the order (rule `own-resources`). Reached only through the checkout facade.
 */
export class ReadDeliveryAddress extends UseCase<
  { readonly addressId: unknown },
  DeliveryAddressView,
  AddressBookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-delivery-address',
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
    return readDeliveryAddress(this.deps, context, input);
  }
}

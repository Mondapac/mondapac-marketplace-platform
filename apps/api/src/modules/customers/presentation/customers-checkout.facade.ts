import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ReadDeliveryAddress } from '../application/use-cases/read-delivery-address.use-case';
import type {
  CustomersCheckoutFacade,
  DeliveryAddress,
  DeliveryAddressFailure,
} from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CustomersCheckoutFacadeImplementation implements CustomersCheckoutFacade {
  constructor(private readonly read: ReadDeliveryAddress) {}

  async deliveryAddress(
    context: CallContext,
    addressId: unknown,
  ): Promise<Result<DeliveryAddress, DeliveryAddressFailure>> {
    const result = await this.read.execute(context, { addressId });
    if (result.ok) {
      const a = result.value;
      return {
        ok: true,
        value: {
          recipientFirstName: a.recipientFirstName,
          recipientLastName: a.recipientLastName,
          phone: a.phone,
          line1: a.line1,
          line2: a.line2,
          suburb: a.suburb,
          region: a.region,
          postcode: a.postcode,
          deliveryNotes: a.deliveryNotes,
          countryCode: a.countryCode,
        },
      };
    }
    switch (result.error.code) {
      case 'access.denied':
        return { ok: false, error: result.error as AccessDenied };
      case 'validation.failed':
        return { ok: false, error: { code: 'validation.failed' } };
      case 'customers.address-not-found':
        return { ok: false, error: { code: 'customers.address-not-found' } };
      default:
        return { ok: false, error: { code: 'customers.unavailable' } };
    }
  }
}

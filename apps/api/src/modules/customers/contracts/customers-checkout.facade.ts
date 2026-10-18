import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * A delivery address as checkout copies it onto an order. PERSONAL DATA: never logged, never in
 * an event or an error.
 */
export interface DeliveryAddress {
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly deliveryNotes: string | null;
  /** ISO 3166 country of the address. */
  readonly countryCode: string;
}

export type DeliveryAddressFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** Unknown, another customer's, or unreadable since the account was erased: one answer. */
  | { readonly code: 'customers.address-not-found' }
  | { readonly code: 'customers.unavailable' };

/** The address book as `ordering` reads it at checkout. */
export interface CustomersCheckoutFacade {
  /** One of the signed-in customer's own addresses, by id. Customer only. */
  deliveryAddress(
    context: CallContext,
    addressId: unknown,
  ): Promise<Result<DeliveryAddress, DeliveryAddressFailure>>;
}

/** Nest token of the {@link CustomersCheckoutFacade}, provided and exported by `CustomersModule`. */
export const CUSTOMERS_CHECKOUT_FACADE = Symbol('CUSTOMERS_CHECKOUT_FACADE');

// Public contracts of the customers module (ADR-0008): the checkout facade interface (package 2);
// no permission key. Other modules may import only what this file exports, through ../index.ts.
export {
  CUSTOMERS_CHECKOUT_FACADE,
  type CustomersCheckoutFacade,
  type DeliveryAddress,
  type DeliveryAddressFailure,
} from './customers-checkout.facade';

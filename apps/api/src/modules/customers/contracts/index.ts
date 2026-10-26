// Public contracts of the customers module (ADR-0008): the checkout facade interface (package 2),
// the permission keys and audit actions of the account deletion setting (package 5a). Other modules may import only what this file exports, through ../index.ts.
export {
  CUSTOMERS_CHECKOUT_FACADE,
  type CustomersCheckoutFacade,
  type DeliveryAddress,
  type DeliveryAddressFailure,
} from './customers-checkout.facade';
export { CUSTOMERS_AUDIT_ACTIONS } from '../domain/audit';
export {
  ACCOUNT_DELETION_SETTINGS_MANAGE,
  ACCOUNT_DELETION_SETTINGS_VIEW,
  CUSTOMERS_PERMISSIONS,
} from './permissions';

// Public contracts of the customers module (ADR-0008): the checkout facade interface (package 2),
// the permission keys, audit actions and step-up action of the account deletion setting
// (package 5a). Other modules may import only what this file exports, through ../index.ts.
export {
  CUSTOMERS_CHECKOUT_FACADE,
  type CustomersCheckoutFacade,
  type DeliveryAddress,
  type DeliveryAddressFailure,
} from './customers-checkout.facade';
export {
  CUSTOMERS_READ_FACADE,
  type CustomerLastOrderFailure,
  type CustomerGroupMembershipFailure,
  type ExclusiveSellerAnswer,
  type ExclusiveSellerFailure,
  type CustomersReadFacade,
} from './customers-read.facade';
export {
  CUSTOMERS_ACCOUNT_DELETION_FACADE,
  type CustomersAccountDeletionFacade,
} from './account-deletion.facade';
export {
  CUSTOMER_GROUP_USAGE_REGISTRY,
  CustomerGroupUsageRegistry,
  type CustomerGroupUsageSource,
  type GroupLiveUse,
} from './group-usage';
export { ACCOUNT_DELETION_SETTINGS_CHANGE_STEP_UP, CUSTOMERS_STEP_UP_ACTIONS } from './step-up';
export { CUSTOMERS_AUDIT_ACTIONS } from '../domain/audit';
export {
  ACCOUNT_DELETION_SETTINGS_MANAGE,
  ACCOUNT_DELETION_SETTINGS_VIEW,
  CUSTOMERS_GROUPS_MANAGE,
  CUSTOMERS_PERMISSIONS,
} from './permissions';

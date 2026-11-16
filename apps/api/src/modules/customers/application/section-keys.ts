import type { PermissionKey } from '../../../platform/authz';

// The keys the owners of the customer page's sections declared (customers management phase 2b).
// Only the declaring module can brand a key, so each is cast here; a contract test pins every
// literal to its owner's declaration. A section's use case declares `customers.customers.view`
// and the owner's key; the owner's facade read declares and checks its key again.

/** identity: a customer's sign-ins (90 days) and live sessions. */
export const IDENTITY_CUSTOMER_SIGN_IN_VIEW = 'identity.customer-sign-in.view' as PermissionKey;
/** identity (protected): the full address of one sign-in. */
export const IDENTITY_CUSTOMER_SIGN_IN_REVEAL = 'identity.customer-sign-in.reveal' as PermissionKey;
/** identity: sign the customer out of every device. */
export const IDENTITY_CUSTOMER_SESSION_END = 'identity.customer-session.end' as PermissionKey;
/** identity: send the customer the password reset mail. */
export const IDENTITY_CUSTOMER_PASSWORD_RESET_SEND =
  'identity.customer-password-reset.send' as PermissionKey;

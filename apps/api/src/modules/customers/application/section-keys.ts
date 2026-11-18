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
/** cart: a customer's current cart and saved-for-later list. */
export const CART_CUSTOMER_CART_VIEW = 'cart.customer-cart.view' as PermissionKey;
/** notifications: the abandoned-cart reminders a customer was sent. */
export const NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW =
  'notifications.customer-cart-reminder.view' as PermissionKey;
/** engagement: a customer's behaviour summary and add-to-cart history (no search text). */
export const ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW =
  'engagement.customer-behaviour.view' as PermissionKey;
/** legal: a customer's marketing consent and its history. */
export const LEGAL_CUSTOMER_CONSENT_VIEW = 'legal.customer-consent.view' as PermissionKey;
/** assistant: the count and dates of a customer's assistant conversations. */
export const ASSISTANT_CUSTOMER_CONVERSATION_VIEW =
  'assistant.customer-conversation.view' as PermissionKey;
/** reviews: a customer's reviews, the seller ratings they gave, their votes and the reports. */
export const REVIEWS_CUSTOMER_REVIEW_VIEW = 'reviews.customer-review.view' as PermissionKey;

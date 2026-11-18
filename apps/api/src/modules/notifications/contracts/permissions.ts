import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of notifications (support contact). The address is what customers and
// sellers are told to write to, so changing it is a protected platform key: only the Platform
// Administrator holds it by definition. Reading it is a plain key.

/** See the Market's support email address. */
export const NOTIFICATIONS_SUPPORT_CONTACT_VIEW = definePermission('notifications', {
  key: 'notifications.support-contact.view',
  scope: 'platform',
  protected: false,
});

/** Change the Market's support email address. */
export const NOTIFICATIONS_SUPPORT_CONTACT_MANAGE = definePermission('notifications', {
  key: 'notifications.support-contact.manage',
  scope: 'platform',
  protected: true,
});

/**
 * See which abandoned-cart reminders one customer was sent (the cart change, the stage, when; kept
 * 30 days) on the customer page (customers management phase 2b). No mail content.
 */
export const NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW = definePermission('notifications', {
  key: 'notifications.customer-cart-reminder.view',
  scope: 'platform',
  protected: false,
});

export const NOTIFICATIONS_PERMISSIONS = declarePermissions('notifications', [
  NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW,
  NOTIFICATIONS_SUPPORT_CONTACT_MANAGE,
  NOTIFICATIONS_SUPPORT_CONTACT_VIEW,
]);

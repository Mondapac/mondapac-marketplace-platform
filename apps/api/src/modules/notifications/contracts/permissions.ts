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

export const NOTIFICATIONS_PERMISSIONS = declarePermissions('notifications', [
  NOTIFICATIONS_SUPPORT_CONTACT_MANAGE,
  NOTIFICATIONS_SUPPORT_CONTACT_VIEW,
]);

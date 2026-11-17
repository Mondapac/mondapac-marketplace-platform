import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of engagement. Every shopper use case is the customer's own
// (`own-resources`); the one key is the admin's read of one customer's behaviour on the customer
// page.

/**
 * See a summary of one customer's shopping behaviour on the customer page (customers management
 * phase 2b): the personalization switch, view counts, the most viewed categories and the
 * add-to-cart history of the 12 months kept. Ids and counts only; never the search text.
 */
export const ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW = definePermission('engagement', {
  key: 'engagement.customer-behaviour.view',
  scope: 'platform',
  protected: false,
});

export const ENGAGEMENT_PERMISSIONS = declarePermissions('engagement', [
  ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW,
]);

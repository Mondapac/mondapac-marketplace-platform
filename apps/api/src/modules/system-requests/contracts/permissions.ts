import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of system-requests (Admin Inbox › System requests; owner decisions of
// 15 Nov 2026). Every key is a protected platform key: only the Platform Administrator holds it by
// definition, or a custom platform role that a Platform Administrator grants. Seeing the queue, the
// review policy and changing the policy each have their own key; each reviewed area has its own
// review key, so a role can review money without reviewing roles.

/** See the System requests queue and a request's detail, and comment on a request. */
export const SYSTEM_REQUESTS_REQUEST_VIEW = definePermission('system-requests', {
  key: 'system-requests.request.view',
  scope: 'platform',
  protected: true,
});

/** See the review policy (which areas are reviewed, their default risk, the review period). */
export const SYSTEM_REQUESTS_POLICY_VIEW = definePermission('system-requests', {
  key: 'system-requests.policy.view',
  scope: 'platform',
  protected: true,
});

/** Change the review policy. The change is itself reviewed, always as high risk. */
export const SYSTEM_REQUESTS_POLICY_MANAGE = definePermission('system-requests', {
  key: 'system-requests.policy.manage',
  scope: 'platform',
  protected: true,
});

/** Review changes to admins and roles, and changes to the review policy itself. */
export const SYSTEM_REQUESTS_PEOPLE_REVIEW = definePermission('system-requests', {
  key: 'system-requests.people.review',
  scope: 'platform',
  protected: true,
});

/** Review changes to tax, refund limits, the wallet and commission. */
export const SYSTEM_REQUESTS_MONEY_REVIEW = definePermission('system-requests', {
  key: 'system-requests.money.review',
  scope: 'platform',
  protected: true,
});

/** Review changes to delivery methods, fleets and service areas. */
export const SYSTEM_REQUESTS_DELIVERY_REVIEW = definePermission('system-requests', {
  key: 'system-requests.delivery.review',
  scope: 'platform',
  protected: true,
});

/** Review merges, moves and deletes of categories and attributes. */
export const SYSTEM_REQUESTS_CATALOGUE_REVIEW = definePermission('system-requests', {
  key: 'system-requests.catalogue.review',
  scope: 'platform',
  protected: true,
});

/** Review changes to certification types and claim policies. */
export const SYSTEM_REQUESTS_CERTIFICATION_REVIEW = definePermission('system-requests', {
  key: 'system-requests.certification.review',
  scope: 'platform',
  protected: true,
});

/** Review marketplace settings (support, assistant, AI, lists, retention), when reviewed. */
export const SYSTEM_REQUESTS_MARKETPLACE_REVIEW = definePermission('system-requests', {
  key: 'system-requests.marketplace.review',
  scope: 'platform',
  protected: true,
});

/** Review published content (pages, slides, menus), when reviewed. */
export const SYSTEM_REQUESTS_CONTENT_REVIEW = definePermission('system-requests', {
  key: 'system-requests.content.review',
  scope: 'platform',
  protected: true,
});

/**
 * Save a filter of the queue for every admin of the Market, and rename, unshare or delete a filter
 * another admin shared (the generic saved-filter routes of `lists`). Without it an admin keeps
 * filters for themselves only; the queue itself still needs `system-requests.request.view`.
 */
export const SYSTEM_REQUESTS_SAVED_FILTER_SHARE = definePermission('system-requests', {
  key: 'system-requests.saved-filter.share',
  scope: 'platform',
  protected: true,
});

export const SYSTEM_REQUESTS_PERMISSIONS = declarePermissions('system-requests', [
  SYSTEM_REQUESTS_CATALOGUE_REVIEW,
  SYSTEM_REQUESTS_CERTIFICATION_REVIEW,
  SYSTEM_REQUESTS_CONTENT_REVIEW,
  SYSTEM_REQUESTS_DELIVERY_REVIEW,
  SYSTEM_REQUESTS_MARKETPLACE_REVIEW,
  SYSTEM_REQUESTS_MONEY_REVIEW,
  SYSTEM_REQUESTS_PEOPLE_REVIEW,
  SYSTEM_REQUESTS_POLICY_MANAGE,
  SYSTEM_REQUESTS_POLICY_VIEW,
  SYSTEM_REQUESTS_REQUEST_VIEW,
  SYSTEM_REQUESTS_SAVED_FILTER_SHARE,
]);
